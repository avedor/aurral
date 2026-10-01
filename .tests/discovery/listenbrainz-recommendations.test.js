import test from "node:test";
import assert from "node:assert/strict";

import axios from "../../lib/axiosFetch.js";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
  createMockHttpServer,
  importFromRepo,
} from "../helpers/backendTestHarness.js";

const [
  state,
  { db },
  { dbOps },
  ,
  {
    getDiscoveryCapabilities,
    hasListenbrainzHistoryProfile,
    DISCOVERY_PROVIDER_LISTENBRAINZ,
  },
] = await setupIsolatedBackend(
  "listenbrainz-recommendations",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
  "backend/services/discovery/persistence.js",
  "backend/services/listenbrainzDiscoveryFallback.js",
);

const {
  fetchListenbrainzSimilarArtists,
  fetchListenbrainzSimilarUsers,
  fetchListenbrainzArtistTags,
  collectListenbrainzSeedTags,
} = await importFromRepo(
  "backend/services/discovery/listenbrainzRecommendations.js",
);
const { buildRecommendationsFromSeeds } = await importFromRepo(
  "backend/services/discovery/recommendations.js",
);

const SEED_MBID = "11111111-1111-4111-8111-111111111111";
const SEED_MBID_2 = "22222222-2222-4222-8222-222222222222";
const SIMILAR_MBID = "33333333-3333-4333-8333-333333333333";
const SIMILAR_MBID_2 = "44444444-4444-4444-8444-444444444444";

const pointMetadataProviderAt = (baseUrl) => {
  const previousSettings = dbOps.getSettings();
  dbOps.updateSettings({
    ...previousSettings,
    integrations: {
      ...(previousSettings.integrations || {}),
      metadata: {
        ...(previousSettings.integrations?.metadata || {}),
        baseUrl,
      },
    },
  });
  return previousSettings;
};

const { clearMetadataProviderCaches } = await importFromRepo(
  "backend/services/providers/brainzmashProvider.js",
);

// axios is shared with the metadata provider, so the ListenBrainz stub has to
// let loopback requests through to the mock HTTP server.
const realAxiosGet = axios.get.bind(axios);
const mockListenbrainzOnly = (t, handler) =>
  t.mock.method(axios, "get", async (url, options) => {
    const target = String(url);
    if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(target)) {
      return realAxiosGet(url, options);
    }
    return handler(target, options);
  });

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.invalidateSettingsCache();
});
test.after(() => cleanupIsolatedState(state));

test("listenbrainz similar artists are mapped, aggregated, and exclude the seed artist", async (t) => {
  mockListenbrainzOnly(t, async () => ({
    status: 200,
    data: {
      payload: {
        mbid: SEED_MBID,
        name: "Seed Artist",
        artists: [
          {
            recording_mbid: "rec-1",
            similar_artist_mbid: SEED_MBID,
            similar_artist_name: "Seed Artist",
            total_listen_count: 500000,
          },
          {
            recording_mbid: "rec-2",
            similar_artist_mbid: SIMILAR_MBID,
            similar_artist_name: "Similar Artist",
            total_listen_count: 12000,
          },
          {
            recording_mbid: "rec-3",
            similar_artist_mbid: SIMILAR_MBID,
            similar_artist_name: "Similar Artist",
            total_listen_count: 8000,
          },
          {
            recording_mbid: "rec-4",
            similar_artist_mbid: SIMILAR_MBID_2,
            similar_artist_name: "Another Artist",
            total_listen_count: 30000000,
          },
        ],
      },
    },
  }));

  const health = { success: 0, failure: 0 };
  const artists = await fetchListenbrainzSimilarArtists(
    { mbid: SEED_MBID, artistName: "Seed Artist" },
    25,
    health,
  );

  assert.equal(health.success, 1);
  assert.equal(artists.length, 2);
  assert.equal(artists[0].name, "Another Artist");
  assert.equal(artists[0].mbid, SIMILAR_MBID_2);
  assert.equal(artists[1].name, "Similar Artist");
  assert.equal(artists[1].mbid, SIMILAR_MBID);
  // 30M listens saturates the match score; the 20k aggregate stays well below it.
  assert.equal(artists[0].match, 1);
  assert.ok(artists[1].match > 0 && artists[1].match < 1);
});

test("listenbrainz similar artists returns empty without an mbid", async () => {
  const health = { success: 0, failure: 0 };
  const artists = await fetchListenbrainzSimilarArtists(
    { artistName: "No Mbid Artist" },
    25,
    health,
  );
  assert.deepEqual(artists, []);
  assert.equal(health.failure, 1);
});

test("listenbrainz similar users are parsed and sorted", async (t) => {
  mockListenbrainzOnly(t, async () => ({
    status: 200,
    data: {
      payload: {
        similar_users: [
          { user_name: "user-b", similarity: 0.12 },
          { user_name: "user-a", similarity: 0.42 },
        ],
      },
    },
  }));

  const users = await fetchListenbrainzSimilarUsers("test-user");
  assert.deepEqual(
    users.map((user) => user.userName),
    ["user-a", "user-b"],
  );
  assert.equal(users[0].similarity, 0.42);
});

test("listenbrainz artist tags come from musicbrainz genres, lowercased", async () => {
  const server = await createMockHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        id: SIMILAR_MBID,
        name: "Similar Artist",
        genres: ["Indie Rock", "shoegaze"],
      }),
    );
  });
  const previousSettings = pointMetadataProviderAt(server.url);
  clearMetadataProviderCaches();
  try {
    const tags = await fetchListenbrainzArtistTags({ mbid: SIMILAR_MBID });
    assert.deepEqual(tags, ["indie rock", "shoegaze"]);
  } finally {
    dbOps.updateSettings(previousSettings);
    clearMetadataProviderCaches();
    await server.close();
  }
});

test("collectListenbrainzSeedTags builds a tag map and weights", async () => {
  const server = await createMockHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    const mbid = String(request.url || "").split("/").pop() || "";
    const genres = mbid === SEED_MBID ? ["indie rock", "shoegaze"] : ["indie rock"];
    response.end(JSON.stringify({ id: mbid, name: "Artist", genres }));
  });
  const previousSettings = pointMetadataProviderAt(server.url);
  clearMetadataProviderCaches();
  try {
    const { tagMap, tagWeights } = await collectListenbrainzSeedTags([
      { mbid: SEED_MBID, artistName: "Seed One", weight: 1.2 },
      { mbid: SEED_MBID_2, artistName: "Seed Two", weight: 1 },
    ]);
    assert.equal(tagMap.size, 2);
    assert.deepEqual(tagMap.get(SEED_MBID), ["indie rock", "shoegaze"]);
    assert.equal(tagWeights.get("indie rock"), 2.2);
    assert.equal(tagWeights.get("shoegaze"), 1.2);
  } finally {
    dbOps.updateSettings(previousSettings);
    clearMetadataProviderCaches();
    await server.close();
  }
});

test("buildRecommendationsFromSeeds generates listenbrainz recommendations without lastfm", async (t) => {
  mockListenbrainzOnly(t, async (url) => {
    const seedMbid = String(url).split("/artist/")[1]?.split("?")[0] || "";
    const similarMbid = seedMbid === SEED_MBID ? SIMILAR_MBID : SIMILAR_MBID_2;
    const similarName = seedMbid === SEED_MBID ? "Similar Artist" : "Another Artist";
    return {
      status: 200,
      data: {
        payload: {
          mbid: seedMbid,
          name: "Seed",
          artists: [
            {
              recording_mbid: `rec-${seedMbid}`,
              similar_artist_mbid: similarMbid,
              similar_artist_name: similarName,
              total_listen_count: 40000,
            },
          ],
        },
      },
    };
  });

  const metadataServer = await createMockHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    const mbid = String(request.url || "").split("/").pop() || "";
    response.end(
      JSON.stringify({ id: mbid, name: "Artist", genres: ["indie rock"] }),
    );
  });
  const previousSettings = pointMetadataProviderAt(metadataServer.url);
  clearMetadataProviderCaches();
  try {
    const recommendations = await buildRecommendationsFromSeeds({
      seeds: [
        {
          mbid: SEED_MBID,
          artistName: "Seed One",
          source: "listenbrainz",
          weight: 1.3,
        },
        {
          mbid: SEED_MBID_2,
          artistName: "Seed Two",
          source: "listenbrainz",
          weight: 1.1,
        },
      ],
      existingArtistKeys: new Set(),
      lastfmHealth: { success: 0, failure: 0 },
      profileTagWeights: new Map([["indie rock", 2.3]]),
      seedTagMap: new Map(),
      discoveryMode: "balanced",
      includeCandidateTagHydration: true,
      includeSecondHop: false,
      source: "listenbrainz",
    });

    assert.ok(recommendations.length >= 2);
    const names = recommendations.map((artist) => artist.name);
    assert.ok(names.includes("Similar Artist"), names.join(", "));
    assert.ok(names.includes("Another Artist"), names.join(", "));
    assert.ok(recommendations.every((artist) => artist.sourceType === "listenbrainz"));
    assert.ok(recommendations.every((artist) => artist.tags.includes("indie rock")));
  } finally {
    dbOps.updateSettings(previousSettings);
    clearMetadataProviderCaches();
    await metadataServer.close();
  }
});

test("discovery capabilities are personalized with listenbrainz history but no lastfm key", () => {
  const withoutHistory = getDiscoveryCapabilities(false, false);
  assert.equal(withoutHistory.personalizedRecommendations, false);

  const withHistory = getDiscoveryCapabilities(false, true);
  assert.equal(withHistory.personalizedRecommendations, true);
  assert.equal(withHistory.globalTrending, true);
  assert.equal(withHistory.genreSections, true);
  // Last.fm-only capabilities stay off without a key.
  assert.equal(withHistory.arbitraryTagSearch, false);
  assert.equal(withHistory.relatedArtists, false);

  const withLastfm = getDiscoveryCapabilities(true, false);
  assert.equal(withLastfm.personalizedRecommendations, true);
  assert.equal(withLastfm.arbitraryTagSearch, true);
});

test("hasListenbrainzHistoryProfile detects configured listenbrainz users", () => {
  assert.equal(hasListenbrainzHistoryProfile(), false);
  assert.equal(DISCOVERY_PROVIDER_LISTENBRAINZ, "listenbrainz");

  db.prepare(
    `INSERT INTO users (username, password_hash, role, listen_history_provider, listen_history_username)
     VALUES ('lb-user', 'hash', 'user', 'listenbrainz', 'lb-listener')`,
  ).run();
  assert.equal(hasListenbrainzHistoryProfile(), true);

  db.prepare("DELETE FROM users").run();
  assert.equal(hasListenbrainzHistoryProfile(), false);
});