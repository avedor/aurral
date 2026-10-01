import { UUID_REGEX } from "../../../lib/uuid.js";
import { listenbrainzRequest, musicbrainzResolveArtistMbidByName } from "../apiClients/index.js";
import { getArtistGenres } from "../providers/brainzmashProvider.js";
import { logger } from "../logger.js";
import {
  getDiscoveryNetworkConcurrency,
  getSeedTagMapKey,
  mapWithConcurrency,
  normalizeSeedTagList,
} from "./helpers.js";
import { recordDiscoveryUpdateProgress } from "./persistence.js";

const normalizeMbid = (value) => {
  const normalized = String(value || "").trim();
  return UUID_REGEX.test(normalized) ? normalized : null;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const toMatchScore = (listenCount) =>
  clamp(Math.log10(Math.max(0, Number(listenCount) || 0) + 1) / 7, 0.05, 1);

export const fetchListenbrainzSimilarArtists = async (
  seed,
  maxSimilarArtists = 25,
  lastfmHealth = null,
) => {
  const seedMbid = normalizeMbid(seed?.mbid || seed?.id);
  if (!seedMbid) {
    if (lastfmHealth) lastfmHealth.failure++;
    return [];
  }
  const limit = Math.max(1, Math.min(100, Math.floor(Number(maxSimilarArtists) || 25)));
  try {
    const data = await listenbrainzRequest(
      `/1/lb-radio/artist/${encodeURIComponent(seedMbid)}`,
      {
        mode: "medium",
        max_similar_artists: limit,
        max_recordings_per_artist: 1,
      },
    );
    if (lastfmHealth) lastfmHealth.success++;
    const entries = Array.isArray(data?.payload?.artists) ? data.payload.artists : [];
    const byArtist = new Map();
    for (const entry of entries) {
      const similarMbid = normalizeMbid(entry?.similar_artist_mbid);
      const name = String(entry?.similar_artist_name || "").trim();
      if (!similarMbid && !name) continue;
      if (similarMbid === seedMbid) continue;
      const listenCount = Math.max(0, Number(entry?.total_listen_count) || 0);
      const key = similarMbid || `name:${name.toLowerCase()}`;
      const existing = byArtist.get(key);
      if (existing) {
        existing.totalListenCount += listenCount;
        existing.occurrences += 1;
      } else {
        byArtist.set(key, {
          mbid: similarMbid,
          name,
          totalListenCount: listenCount,
          occurrences: 1,
        });
      }
    }
    return [...byArtist.values()]
      .sort((left, right) => right.totalListenCount - left.totalListenCount)
      .slice(0, limit)
      .map((entry) => ({
        mbid: entry.mbid,
        name: entry.name,
        image: null,
        match: toMatchScore(entry.totalListenCount),
      }));
  } catch (error) {
    if (lastfmHealth) lastfmHealth.failure++;
    logger.warn(
      'discovery',
      `ListenBrainz similar artists failed for ${seedMbid}: ${error.message}`,
    );
    return [];
  }
};

export const fetchListenbrainzSimilarUsers = async (username) => {
  const safeUsername = String(username || "").trim();
  if (!safeUsername) return [];
  const data = await listenbrainzRequest(
    `/1/user/${encodeURIComponent(safeUsername)}/similar-users`,
  ).catch(() => null);
  const payload = data?.payload;
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.similar_users)
      ? payload.similar_users
      : Array.isArray(payload?.users)
        ? payload.users
        : Array.isArray(data)
          ? data
          : [];
  return list
    .map((entry) => ({
      userName: String(entry?.user_name || entry?.userName || "").trim(),
      similarity: Number(entry?.similarity || 0),
    }))
    .filter((entry) => entry.userName)
    .sort((left, right) => right.similarity - left.similarity);
};

export const fetchListenbrainzArtistTags = async (artist) => {
  const artistName = String(artist?.name || artist?.artistName || "").trim();
  let mbid = normalizeMbid(artist?.id || artist?.mbid);
  if (!mbid && artistName) {
    mbid =
      (await musicbrainzResolveArtistMbidByName(artistName).catch(() => null)) || null;
  }
  if (!mbid) return [];
  const genres = await getArtistGenres(mbid).catch(() => []);
  // MusicBrainz genres are title-cased; the rest of the pipeline keys tags in
  // lowercase (matching what Last.fm artist.getTopTags returns).
  return normalizeSeedTagList(
    (Array.isArray(genres) ? genres : []).map((genre) =>
      String(genre || "").trim().toLowerCase(),
    ),
  );
};

export const collectListenbrainzSeedTags = async (
  seeds,
  progressPhase = null,
) => {
  const tagCounts = new Map();
  const tagMap = new Map();

  if (progressPhase) {
    recordDiscoveryUpdateProgress(progressPhase, "Building genre and tag profile", 35);
  }

  await mapWithConcurrency(
    seeds,
    getDiscoveryNetworkConcurrency(),
    async (seed) => {
      try {
        const tags = await fetchListenbrainzArtistTags(seed);
        if (tags.length === 0) return;

        const tagMapKey = getSeedTagMapKey(seed);
        if (tagMapKey) {
          tagMap.set(tagMapKey, tags);
        }

        for (const tag of tags) {
          tagCounts.set(
            tag,
            (tagCounts.get(tag) || 0) + Math.max(0.5, seed.weight || 1),
          );
        }
      } catch (error) {
        logger.warn(
          'discovery',
          `Failed to get ListenBrainz tags for ${seed.artistName}: ${error.message}`,
        );
      }
    },
  );

  return {
    tagMap,
    tagWeights: tagCounts,
  };
};
