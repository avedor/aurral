import {
  getDiscoveryCandidateLimit,
  getDiscoveryNetworkConcurrency,
  getLastfmFailureRatio,
  getSimilarArtistSampling,
  getSecondHopArtistSampling,
  getSecondHopRecommendationLimit,
  getCandidateTagHydrationLimit,
  normalizeSeedTagList,
  getSeedTagMapKey,
  pickLastfmImage,
  mapWithConcurrency,
} from "./helpers.js";
import { lastfmRequest } from "../apiClients/index.js";
import { logger } from "../logger.js";
import {
  addRecommendationCandidate,
  finalizeRecommendationAccumulator,
  mergeResolvedRecommendations,
  rerankRecommendations,
} from "./recommendationPipeline.js";
import { hydrateRecommendationCandidateTags } from "./tasteProfile.js";
import { fetchListenbrainzSimilarArtists, fetchListenbrainzArtistTags } from "./listenbrainzRecommendations.js";

const fetchLastfmArtistTags = async (seed, lastfmHealth) => {
  const tagData = await lastfmRequest(
    "artist.getTopTags",
    seed.mbid ? { mbid: seed.mbid } : { artist: seed.artistName },
  );
  if (tagData && !tagData.error) lastfmHealth.success++; else lastfmHealth.failure++;
  if (!tagData?.toptags?.tag) return [];

  const tags = Array.isArray(tagData.toptags.tag)
    ? tagData.toptags.tag
    : [tagData.toptags.tag];
  return normalizeSeedTagList(
    tags.map((tag) => tag?.name),
  );
};

const fetchLastfmSimilarArtists = async (seed, limit, lastfmHealth) => {
  const similar = await lastfmRequest(
    "artist.getSimilar",
    seed.mbid
      ? { mbid: seed.mbid, limit }
      : { artist: seed.artistName, limit },
  );
  if (similar && !similar.error) lastfmHealth.success++; else lastfmHealth.failure++;
  if (!similar?.similarartists?.artist) return [];

  const artists = Array.isArray(similar.similarartists.artist)
    ? similar.similarartists.artist
    : [similar.similarartists.artist];
  return artists.map((artist) => ({
    mbid: artist?.mbid,
    name: artist?.name,
    image: pickLastfmImage(artist?.image),
    match: artist?.match,
  }));
};

export const buildRecommendationsFromSeeds = async ({
  seeds,
  existingArtistKeys,
  lastfmHealth,
  profileTagWeights,
  seedTagMap = new Map(),
  discoveryMode,
  includeCandidateTagHydration = true,
  includeSecondHop = true,
  source = "lastfm",
}) => {
  const useListenbrainz = source === "listenbrainz";
  const fetchSimilarArtists = useListenbrainz
    ? (seed, limit) => fetchListenbrainzSimilarArtists(seed, limit, lastfmHealth)
    : (seed, limit) => fetchLastfmSimilarArtists(seed, limit, lastfmHealth);
  const fetchArtistTags = useListenbrainz
    ? (seed) => fetchListenbrainzArtistTags(seed)
    : (seed) => fetchLastfmArtistTags(seed, lastfmHealth);

  const directRecommendations = new Map();
  const { similarLimit, maxPerSeed } = getSimilarArtistSampling(
    getLastfmFailureRatio(lastfmHealth),
  );

  await mapWithConcurrency(
    seeds,
    getDiscoveryNetworkConcurrency(),
    async (seed) => {
      try {
        const seedTagKey = getSeedTagMapKey(seed);
        let sourceTags = normalizeSeedTagList(seedTagMap.get(seedTagKey));
        if (sourceTags.length > 0) {
          lastfmHealth.success++;
        } else {
          sourceTags = await fetchArtistTags(seed);
        }

        const similar = await fetchSimilarArtists(seed, similarLimit);
        for (const artist of similar.slice(0, maxPerSeed)) {
          addRecommendationCandidate(directRecommendations, {
            candidate: {
              mbid: artist?.mbid,
              name: artist?.name,
              image: artist?.image ?? null,
              match: artist?.match,
              discoveryDepth: 1,
            },
            seed,
            sourceTags,
            profileTagWeights,
            existingArtistKeys,
          });
        }
      } catch (error) {
        logger.warn(
          'discovery',
          `Error getting similar artists for ${seed.artistName}: ${error.message}`,
        );
      }
    },
  );

  const candidateLimit = getDiscoveryCandidateLimit();
  let directList = finalizeRecommendationAccumulator(
    directRecommendations,
    candidateLimit,
    { discoveryMode },
  );
  if (includeCandidateTagHydration) {
    directList = await hydrateRecommendationCandidateTags({
      recommendations: directList,
      lastfmHealth,
      profileTagWeights,
      limit: getCandidateTagHydrationLimit(
        directList.length,
        getLastfmFailureRatio(lastfmHealth),
        1,
      ),
      depth: 1,
      fetchTags: useListenbrainz
        ? (item) => fetchListenbrainzArtistTags(item)
        : null,
    });
  }
  directList = rerankRecommendations(directList, candidateLimit, {
    discoveryMode,
  });

  if (!includeSecondHop) {
    return directList;
  }

  const secondHopSampling = getSecondHopArtistSampling(
    getLastfmFailureRatio(lastfmHealth),
  );
  if (secondHopSampling.seedLimit <= 0 || directList.length === 0) {
    return directList;
  }

  const secondHopRecommendations = new Map();
  const bridgeSeeds = directList
    .filter((candidate) => candidate?.name)
    .filter((candidate) => {
      const tags = Array.isArray(candidate.matchedTags)
        ? candidate.matchedTags
        : candidate.tags || [];
      return tags.length > 0;
    })
    .slice(0, secondHopSampling.seedLimit);

  await mapWithConcurrency(
    bridgeSeeds,
    getDiscoveryNetworkConcurrency(),
    async (bridge) => {
      try {
        const bridgeTags = normalizeSeedTagList(
          bridge.matchedTags?.length ? bridge.matchedTags : bridge.tags,
        );
        if (bridgeTags.length === 0) return;

        const bridgeWeight = Math.min(
          0.78,
          Math.max(
            0.45,
            0.42 +
              Number(bridge.bestMatch || 0) * 0.25 +
              Math.min(Number(bridge.seedCount || 0), 3) * 0.04,
          ),
        );
        const bridgeSeed = {
          mbid: bridge.id || bridge.mbid || null,
          artistName: bridge.name,
          source: useListenbrainz ? "listenbrainz_related" : "lastfm_related",
          profileBucket: "two_hop_bridge",
          weight: bridgeWeight,
          affinityWeight: bridgeWeight,
          discoveryDepth: 2,
          similarityMultiplier: 0.55,
          tagAffinityMultiplier: 0.55,
        };
        const similar = await fetchSimilarArtists(bridgeSeed, secondHopSampling.similarLimit);
        for (const artist of similar.slice(0, secondHopSampling.maxPerSeed)) {
          addRecommendationCandidate(secondHopRecommendations, {
            candidate: {
              mbid: artist?.mbid,
              name: artist?.name,
              image: artist?.image ?? null,
              match: artist?.match,
              discoveryDepth: 2,
              similarityMultiplier: 0.55,
              tagAffinityMultiplier: 0.55,
            },
            seed: bridgeSeed,
            sourceTags: bridgeTags,
            profileTagWeights,
            existingArtistKeys,
          });
        }
      } catch (error) {
        logger.warn(
          'discovery',
          `Error getting second-hop similar artists for ${bridge.name}: ${error.message}`,
        );
      }
    },
  );

  let secondHopList = finalizeRecommendationAccumulator(
    secondHopRecommendations,
    getSecondHopRecommendationLimit(),
    { discoveryMode },
  );
  secondHopList = await hydrateRecommendationCandidateTags({
    recommendations: secondHopList,
    lastfmHealth,
    profileTagWeights,
    limit: getCandidateTagHydrationLimit(
      secondHopList.length,
      getLastfmFailureRatio(lastfmHealth),
      2,
    ),
    depth: 2,
    fetchTags: useListenbrainz
      ? (item) => fetchListenbrainzArtistTags(item)
      : null,
  });
  secondHopList = rerankRecommendations(
    secondHopList,
    getSecondHopRecommendationLimit(),
    { discoveryMode },
  );
  if (secondHopList.length === 0) {
    return directList;
  }

  const result = rerankRecommendations(
    mergeResolvedRecommendations(
      [...directList, ...secondHopList],
      existingArtistKeys,
    ),
    candidateLimit,
    { discoveryMode },
  );
  return result;
};
