import {
  listenbrainzRequest,
  musicbrainzGetCachedArtistMbidByName,
  musicbrainzResolveArtistMbidByName,
  musicbrainzGetRecordingsByIds,
} from "../apiClients/index.js";

const LB_RADIO_DEFAULT_MODE = "easy";
const LB_RADIO_DEFAULT_MAX_SIMILAR_ARTISTS = 30;
const LB_RADIO_DEFAULT_MAX_RECORDINGS_PER_ARTIST = 10;

const artistMbidCache = new Map();
const radioCache = new Map();
const recordingMetadataCache = new Map();

export const isValidMbid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value || "").trim(),
  );

export async function resolveFlowArtistMbid(artistLike = {}) {
  const source = artistLike && typeof artistLike === "object" ? artistLike : {};
  for (const key of ["artistMbid", "mbid", "id", "foreignArtistId"]) {
    const candidate = String(source[key] || "").trim();
    if (isValidMbid(candidate)) return candidate.toLowerCase();
  }
  const name = String(source?.name || source?.artistName || "").trim();
  if (!name) return null;
  const cacheKey = name.toLowerCase();
  if (artistMbidCache.has(cacheKey)) {
    return artistMbidCache.get(cacheKey);
  }
  const cachedMbid = musicbrainzGetCachedArtistMbidByName(name);
  if (cachedMbid) {
    artistMbidCache.set(cacheKey, cachedMbid);
    return cachedMbid;
  }
  const resolved = await musicbrainzResolveArtistMbidByName(name).catch(() => null);
  artistMbidCache.set(cacheKey, resolved);
  return resolved;
}

export async function fetchListenbrainzArtistRadio(seedMbid, options = {}) {
  const mbid = String(seedMbid || "").trim().toLowerCase();
  if (!isValidMbid(mbid)) return {};
  if (radioCache.has(mbid)) return radioCache.get(mbid);
  const params = {
    mode: String(options?.mode || LB_RADIO_DEFAULT_MODE).trim(),
    max_similar_artists: Number(
      options?.maxSimilarArtists ?? LB_RADIO_DEFAULT_MAX_SIMILAR_ARTISTS,
    ),
    max_recordings_per_artist: Number(
      options?.maxRecordingsPerArtist ?? LB_RADIO_DEFAULT_MAX_RECORDINGS_PER_ARTIST,
    ),
    pop_begin: Number(options?.popBegin ?? 0),
    pop_end: Number(options?.popEnd ?? 100),
  };
  const data = await listenbrainzRequest(
    `/1/lb-radio/artist/${encodeURIComponent(mbid)}`,
    params,
  ).catch(() => null);
  const dict = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  radioCache.set(mbid, dict);
  return dict;
}

export async function fetchListenbrainzSitewideRecordings({ count = 50 } = {}) {
  const safeCount = Math.min(1000, Math.max(1, Number(count) || 50));
  const data = await listenbrainzRequest("/1/stats/sitewide/recordings", {
    count: safeCount,
  }).catch(() => null);
  return Array.isArray(data?.recordings) ? data.recordings : [];
}

export async function fetchListenbrainzTagTracks({
  tag,
  count = 50,
  operator = "OR",
  popBegin = 0,
  popEnd = 100,
} = {}) {
  const safeTag = String(tag || "").trim();
  if (!safeTag) return [];
  const safeCount = Math.min(1000, Math.max(1, Number(count) || 50));
  const data = await listenbrainzRequest("/1/lb-radio/tags", {
    tag: safeTag,
    count: safeCount,
    operator: String(operator || "OR").trim().toUpperCase() === "AND" ? "AND" : "OR",
    pop_begin: Math.max(0, Number(popBegin) || 0),
    pop_end: Math.min(100, Math.max(0, Number(popEnd) ?? 100) || 100),
  }).catch(() => null);
  return Array.isArray(data) ? data : [];
}

export function flattenRadioEntries(radio = {}) {
  const entries = [];
  const seen = new Set();
  for (const artistName of Object.keys(radio)) {
    const list = Array.isArray(radio[artistName]) ? radio[artistName] : [];
    for (const item of list) {
      const recordingMbid = String(item?.recording_mbid || "").trim().toLowerCase();
      if (!isValidMbid(recordingMbid) || seen.has(recordingMbid)) continue;
      seen.add(recordingMbid);
      entries.push({
        recordingMbid,
        artistMbid: String(item?.similar_artist_mbid || "").trim().toLowerCase(),
        artistName:
          String(item?.similar_artist_name || "").trim() ||
          String(artistName || "").trim(),
        listenCount: Number(
          item?.total_listen_count ?? item?.listen_count ?? 0,
        ),
      });
    }
  }
  return entries;
}

export function filterRadioEntriesByArtist(entries, seedMbid) {
  const mbid = String(seedMbid || "").trim().toLowerCase();
  if (!isValidMbid(mbid)) return [];
  return entries.filter((entry) => entry.artistMbid === mbid);
}

export async function resolveListenbrainzRecordings(recordingMbids) {
  const unique = [
    ...new Set(
      (Array.isArray(recordingMbids) ? recordingMbids : [])
        .map((mbid) => String(mbid || "").trim().toLowerCase())
        .filter(isValidMbid),
    ),
  ];
  if (unique.length === 0) return new Map();
  const missing = unique.filter(
    (mbid) => !recordingMetadataCache.has(mbid),
  );
  if (missing.length > 0) {
    const resolved = await musicbrainzGetRecordingsByIds(missing);
    for (const recording of resolved) {
      recordingMetadataCache.set(recording.trackMbid.toLowerCase(), recording);
    }
    for (const mbid of missing) {
      if (!recordingMetadataCache.has(mbid)) {
        recordingMetadataCache.set(mbid, null);
      }
    }
  }
  const map = new Map();
  for (const mbid of unique) {
    const recording = recordingMetadataCache.get(mbid);
    if (recording) map.set(mbid, recording);
  }
  return map;
}