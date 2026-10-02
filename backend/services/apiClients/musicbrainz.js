import axios from "../../../lib/axiosFetch.js";
import createRateLimiter from "./rateLimiter.js";
import createCache from "./simpleCache.js";
import { dbOps } from "../../db/helpers/index.js";
import {
  MUSICBRAINZ_API,
  APP_NAME,
  APP_VERSION,
} from "../../config/constants.js";
import {
  getArtistByMbid as getMetadataArtistByMbid,
  getArtistNameByMbid as getMetadataArtistNameByMbid,
  legacyMusicbrainzRequest,
  listArtistAlbums as listMetadataArtistAlbums,
  resolveArtistByName as resolveMetadataArtistByName,
  resolveLibraryArtistByName as resolveMetadataLibraryArtistByName,
} from "../providers/brainzmashProvider.js";
import { getLinkedArtistProviderIds } from "../providers/brainzmashMappers.js";
import { getMusicBrainzContact } from "./config.js";
import { runSharedInflight } from "../sharedInflight.js";
import { logger } from "../logger.js";

const musicbrainzArtistNameCache = createCache(3600);
const musicbrainzReleaseGroupsCache = createCache(300);
const musicbrainzAppearsOnCache = createCache(6 * 60 * 60, 200);
const APPEARS_ON_PAGE_SIZE = 100;
const APPEARS_ON_MAX_RELEASES = 1000;
const musicbrainzRecordingCache = createCache(21600);
const musicbrainzInflightRequests = new Map();
const PRIMARY_RELEASE_TYPES = ["Album", "EP", "Single"];
const SECONDARY_RELEASE_TYPES = [
  "Live",
  "Remix",
  "Compilation",
  "Demo",
  "Broadcast",
  "Soundtrack",
  "Spokenword",
  "Other",
];

const mbLimiter = createRateLimiter(1000);
// MusicBrainz caps Lucene query length, so recording batches stay modest.
const RECORDING_LOOKUP_BATCH_SIZE = 10;

export const musicbrainzRequest = async (endpoint, params = {}) =>
  legacyMusicbrainzRequest(endpoint, params);

const isValidMbid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value || "").trim(),
  );

const parseMusicbrainzRecordingEntity = (recording) => {
  if (!recording?.id) return null;
  const artistCredits = Array.isArray(recording["artist-credit"])
    ? recording["artist-credit"]
    : [];
  const artistName = artistCredits
    .map(
      (credit) =>
        `${String(credit?.name || "").trim()}${String(credit?.joinphrase || "").trim()}`,
    )
    .join("")
    .trim();
  const primaryArtist = artistCredits.find(
    (credit) => String(credit?.artist?.id || "").trim(),
  );
  const releases = Array.isArray(recording.releases) ? recording.releases : [];
  const primaryRelease = releases[0] || null;
  const releaseGroup = primaryRelease?.["release-group"] || null;
  const durationMs = Number.parseInt(recording?.length, 10);
  return {
    trackMbid: String(recording.id).trim(),
    title: String(recording?.title || "").trim(),
    artistName: artistName || null,
    artistMbid: String(primaryArtist?.artist?.id || "").trim() || null,
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null,
    releaseName:
      String(primaryRelease?.title || releaseGroup?.title || "").trim() || null,
    releaseMbid: String(primaryRelease?.id || "").trim() || null,
    firstReleaseDate:
      String(
        primaryRelease?.date || releaseGroup?.["first-release-date"] || "",
      ).trim() || null,
  };
};

export async function musicbrainzGetRecordingsByIds(mbids, { signal } = {}) {
  const unique = [
    ...new Set(
      (Array.isArray(mbids) ? mbids : [])
        .map((mbid) => String(mbid || "").trim().toLowerCase())
        .filter(isValidMbid),
    ),
  ];
  if (unique.length === 0) return [];
  const resolved = new Map();
  const missing = [];
  for (const mbid of unique) {
    const cached = musicbrainzRecordingCache.get(mbid);
    if (cached !== undefined) {
      if (cached) resolved.set(mbid, cached);
    } else {
      missing.push(mbid);
    }
  }
  if (missing.length > 0) {
    const contact =
      (getMusicBrainzContact() || "").trim() || "https://github.com/aurral";
    const userAgent = `${APP_NAME}/${APP_VERSION} ( ${contact} )`;
    for (let offset = 0; offset < missing.length; offset += RECORDING_LOOKUP_BATCH_SIZE) {
      const batch = missing.slice(offset, offset + RECORDING_LOOKUP_BATCH_SIZE);
      try {
        const response = await mbLimiter.schedule(async () => {
          signal?.throwIfAborted?.();
          // MusicBrainz rejects semicolon-batched path lookups on /recording/
          // with 400 "Invalid mbid.", so batched lookups use Lucene search on
          // the recording ids instead.
          return axios.get(`${MUSICBRAINZ_API}/recording`, {
            params: {
              query: `rid:(${batch.map((mbid) => `(${mbid})`).join(" OR ")})`,
              fmt: "json",
              inc: "artist-credits+releases",
              limit: batch.length,
            },
            headers: { "User-Agent": userAgent },
            timeout: 12000,
            signal,
          });
        });
        const recordings = Array.isArray(response?.data?.recordings)
          ? response.data.recordings
          : [];
        const byId = new Map(
          recordings
            .map((entry) => {
              const parsed = parseMusicbrainzRecordingEntity(entry);
              return parsed
                ? [String(parsed.trackMbid).toLowerCase(), parsed]
                : null;
            })
            .filter(Boolean),
        );
        for (const mbid of batch) {
          const parsed = byId.get(mbid) || null;
          musicbrainzRecordingCache.set(mbid, parsed);
          if (parsed) resolved.set(mbid, parsed);
        }
      } catch {
        for (const mbid of batch) {
          musicbrainzRecordingCache.set(mbid, null);
        }
      }
    }
  }
  return unique.map((mbid) => resolved.get(mbid)).filter(Boolean);
}

export async function musicbrainzGetArtistReleaseGroups(
  mbid,
  selectedReleaseTypes = null,
  { includeTrackCounts = true, hydrateLimit = includeTrackCounts ? 30 : 6, signal } = {},
) {
  const safeHydrateLimit =
    Number.isFinite(Number(hydrateLimit)) && Number(hydrateLimit) >= 0
      ? Math.min(100, Math.floor(Number(hydrateLimit)))
      : includeTrackCounts
        ? 30
        : 6;
  const cacheKey = `full:${mbid}:${JSON.stringify(selectedReleaseTypes || [])}:${includeTrackCounts ? "rated" : "dated"}:${safeHydrateLimit}`;
  const cached = musicbrainzReleaseGroupsCache.get(cacheKey);
  if (cached) return cached;
  try {
    const items = await listMetadataArtistAlbums(mbid, {
      releaseTypes: selectedReleaseTypes || [],
      includeTrackCounts,
      hydrateLimit: safeHydrateLimit,
      signal,
    });
    const mapped = items.map((item) => ({
      id: item.id,
      title: item.title || "",
      "first-release-date": item.firstReleaseDate || null,
      "primary-type": item.type || "Album",
      "secondary-types": Array.isArray(item.secondaryTypes)
        ? item.secondaryTypes
        : [],
      rating: item.rating || null,
      "artist-credit": item.artistName
        ? [
            {
              name: item.artistName,
              artist: item.artistId
                ? { id: item.artistId, name: item.artistName }
                : { name: item.artistName },
            },
          ]
        : [],
    }));
    musicbrainzReleaseGroupsCache.set(cacheKey, mapped);
    return mapped;
  } catch {
    return [];
  }
}

const artistCreditIncludesMbid = (artistCredit, mbid) => {
  const normalizedMbid = String(mbid || "")
    .trim()
    .toLowerCase();
  if (!normalizedMbid || !Array.isArray(artistCredit)) return false;
  return artistCredit.some(
    (credit) =>
      String(credit?.artist?.id || "")
        .trim()
        .toLowerCase() === normalizedMbid,
  );
};

const browseMusicbrainzTrackArtistReleases = async (mbid, { offset = 0, signal } = {}) => {
  const contact =
    (getMusicBrainzContact() || "").trim() || "https://github.com/aurral";
  const userAgent = `${APP_NAME}/${APP_VERSION} ( ${contact} )`;
  return mbLimiter.schedule(async () => {
    signal?.throwIfAborted?.();
    const response = await axios.get(`${MUSICBRAINZ_API}/release`, {
      params: {
        fmt: "json",
        track_artist: mbid,
        inc: "release-groups+artist-credits",
        limit: APPEARS_ON_PAGE_SIZE,
        offset,
      },
      headers: { "User-Agent": userAgent },
      timeout: 8000,
      signal,
    });
    return response.data;
  });
};

const mapAppearsOnReleaseGroup = (release) => {
  const releaseGroup = release["release-group"];
  const artistCredit =
    Array.isArray(releaseGroup["artist-credit"]) && releaseGroup["artist-credit"].length
      ? releaseGroup["artist-credit"]
      : Array.isArray(release["artist-credit"])
        ? release["artist-credit"]
        : [];
  return {
    id: releaseGroup.id,
    title: releaseGroup.title || release.title || "Untitled release",
    "first-release-date": releaseGroup["first-release-date"] || release.date || null,
    "primary-type": releaseGroup["primary-type"] || "Album",
    "secondary-types": Array.isArray(releaseGroup["secondary-types"])
      ? releaseGroup["secondary-types"]
      : [],
    rating: null,
    "artist-credit": artistCredit,
    releases: release.id
      ? [
          {
            id: release.id,
            status: release.status || null,
            date: release.date || null,
            title: release.title || releaseGroup.title || "Untitled release",
          },
        ]
      : [],
  };
};

const scanAppearsOnPage = async (mbid, state, signal) => {
  const data = await browseMusicbrainzTrackArtistReleases(mbid, {
    offset: state.nextOffset,
    signal,
  });
  const releases = Array.isArray(data?.releases) ? data.releases : [];
  for (const release of releases) {
    const releaseGroupId = String(release?.["release-group"]?.id || "").trim();
    if (!releaseGroupId || state.byReleaseGroupId.has(releaseGroupId)) continue;
    if (
      artistCreditIncludesMbid(release["artist-credit"], mbid) ||
      artistCreditIncludesMbid(release["release-group"]["artist-credit"], mbid)
    ) {
      continue;
    }
    state.byReleaseGroupId.set(releaseGroupId, mapAppearsOnReleaseGroup(release));
  }
  state.nextOffset += releases.length;
  const releaseCount = Number(data?.["release-count"]);
  state.complete =
    releases.length === 0 ||
    state.nextOffset >= APPEARS_ON_MAX_RELEASES ||
    (Number.isFinite(releaseCount) && state.nextOffset >= releaseCount);
  musicbrainzAppearsOnCache.set(mbid, state);
  return state;
};

export async function musicbrainzGetArtistAppearsOnReleaseGroups(
  mbid,
  { limit = 24, offset = 0, signal, scanPageBudget = 1 } = {},
) {
  if (!mbid) return [];
  const safeLimit = Math.min(
    250,
    Math.max(1, Number.parseInt(limit, 10) || 24),
  );
  const safeOffset = Math.min(250, Math.max(0, Number.parseInt(offset, 10) || 0));
  const targetCount = Math.min(250, safeOffset + safeLimit);
  const parsedScanPageBudget = Number.parseInt(scanPageBudget, 10);
  const safeScanPageBudget = Math.min(
    10,
    Math.max(0, Number.isFinite(parsedScanPageBudget) ? parsedScanPageBudget : 1),
  );

  let state = musicbrainzAppearsOnCache.get(mbid) || {
    byReleaseGroupId: new Map(),
    nextOffset: 0,
    complete: false,
  };
  try {
    for (
      let scannedPages = 0;
      state.byReleaseGroupId.size < targetCount &&
      !state.complete &&
      scannedPages < safeScanPageBudget;
      scannedPages += 1
    ) {
      const current = state;
      state = await runSharedInflight(
        musicbrainzInflightRequests,
        `appears-on-page:${mbid}`,
        (sharedSignal) => scanAppearsOnPage(mbid, current, sharedSignal),
        { signal },
      );
    }
  } catch (error) {
    if (!signal?.aborted && error?.name !== "AbortError") {
      logger.warn("musicbrainz", "Artist appearances lookup failed", {
        mbid,
        message: error.message,
      });
    }
    throw error;
  }

  return [...state.byReleaseGroupId.values()]
    .sort((left, right) =>
      String(right["first-release-date"] || "").localeCompare(
        String(left["first-release-date"] || ""),
      ),
    )
    .slice(safeOffset, targetCount);
}

export const getMusicbrainzAppearsOnScanState = (mbid) => {
  const state = musicbrainzAppearsOnCache.get(mbid);
  if (!state) return { complete: false, nextOffset: 0 };
  return {
    complete: state.complete,
    nextOffset: state.nextOffset,
  };
};

export async function musicbrainzGetArtistNameByMbid(mbid, { signal } = {}) {
  if (!mbid) return null;
  const cached = musicbrainzArtistNameCache.get(mbid);
  if (cached !== undefined) return cached;
  try {
    const name = await getMetadataArtistNameByMbid(mbid, { signal });
    const normalized = name && typeof name === "string" ? name.trim() : null;
    musicbrainzArtistNameCache.set(mbid, normalized);
    return normalized;
  } catch (e) {
    musicbrainzArtistNameCache.set(mbid, null);
    return null;
  }
}

export async function musicbrainzGetArtistIdentityByMbid(mbid, { signal } = {}) {
  const normalizedMbid = String(mbid || "").trim();
  if (!normalizedMbid) return null;
  try {
    const artist = await getMetadataArtistByMbid(normalizedMbid, { signal });
    return {
      mbid: normalizedMbid,
      name: artist.name || null,
      aliases: [...new Set(artist.aliases)],
      providerIds: getLinkedArtistProviderIds(artist.links),
    };
  } catch {
    return null;
  }
}

function normalizeArtistNameKey(artistName) {
  return String(artistName || "")
    .trim()
    .toLowerCase();
}

export function musicbrainzGetCachedArtistMbidByName(artistName) {
  const normalized = normalizeArtistNameKey(artistName);
  if (!normalized) return null;
  const cached = dbOps.getMusicbrainzArtistMbidCache(normalized);
  if (!cached?.updatedAt) return null;
  const ageMs = Date.now() - cached.updatedAt;
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const NEGATIVE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
  const cacheTtl = cached.mbid ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
  if (ageMs < 0 || ageMs >= cacheTtl) return null;
  return cached.mbid || null;
}

async function resolveCachedArtistMbid(cacheKey, artistName, resolve, { throwOnError = false } = {}) {
  const cached = dbOps.getMusicbrainzArtistMbidCache(cacheKey);
  const now = Date.now();
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const NEGATIVE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
  if (cached?.updatedAt) {
    const ageMs = now - cached.updatedAt;
    const cacheTtl = cached.mbid ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
    if (ageMs >= 0 && ageMs < cacheTtl) {
      return cached.mbid || null;
    }
  }
  try {
    const resolved = await resolve(artistName);
    dbOps.setMusicbrainzArtistMbidCache(cacheKey, resolved);
    return resolved;
  } catch (e) {
    if (throwOnError) throw e;
    if (cached) {
      return cached.mbid || null;
    }
    return null;
  }
}

export async function musicbrainzResolveArtistMbidByName(artistName) {
  const rawName = String(artistName || "").trim();
  if (!rawName) return null;
  return resolveCachedArtistMbid(
    normalizeArtistNameKey(rawName),
    rawName,
    resolveMetadataArtistByName,
  );
}

export async function musicbrainzResolveLibraryArtistMbid(artistName) {
  const rawName = String(artistName || "").trim();
  if (!rawName) return null;
  return resolveCachedArtistMbid(
    `library:${normalizeArtistNameKey(rawName)}`,
    rawName,
    resolveMetadataLibraryArtistByName,
    { throwOnError: true },
  );
}

export {
  PRIMARY_RELEASE_TYPES,
  SECONDARY_RELEASE_TYPES,
  musicbrainzArtistNameCache,
  musicbrainzReleaseGroupsCache,
};
