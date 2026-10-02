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
  const seenParams = [];
  // Real LB Radio shape: a bare dict keyed by similar artist MBID, values are
  // arrays of recording entries. Not a { payload: { artists } } envelope.
  mockListenbrainzOnly(t, async (_url, options) => {
    seenParams.push(options?.params || {});
    return {
      status: 200,
      data: {
        [SEED_MBID]: [
          {
            recording_mbid: "11111111-1111-4111-8111-111111111111",
            similar_artist_mbid: SEED_MBID,
            similar_artist_name: "Seed Artist",
            total_listen_count: 500000,
          },
        ],
        [SIMILAR_MBID]: [
          {
            recording_mbid: "22222222-2222-4222-8222-222222222222",
            similar_artist_mbid: SIMILAR_MBID,
            similar_artist_name: "Similar Artist",
            total_listen_count: 12000,
          },
          {
            recording_mbid: "33333333-3333-4333-8333-333333333333",
            similar_artist_mbid: SIMILAR_MBID,
            similar_artist_name: "Similar Artist",
            total_listen_count: 8000,
          },
        ],
        [SIMILAR_MBID_2]: [
          {
            recording_mbid: "44444444-4444-4444-8444-444444444444",
            similar_artist_mbid: SIMILAR_MBID_2,
            similar_artist_name: "Another Artist",
            total_listen_count: 30000000,
          },
        ],
      },
    };
  });

  const health = { success: 0, failure: 0 };
  const artists = await fetchListenbrainzSimilarArtists(
    { mbid: SEED_MBID, artistName: "Seed Artist" },
    25,
    health,
  );

  // LB Radio rejects the request with 400 when either bound is missing.
  assert.equal(seenParams.length, 1, "expected one lb-radio request");
  assert.equal(seenParams[0].pop_begin, 0, "pop_begin must be sent");
  assert.equal(seenParams[0].pop_end, 100, "pop_end must be sent");
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

test("listenbrainz requests retry after a 429 and honour the rate limit reset", async (t) => {
  let attempts = 0;
  mockListenbrainzOnly(t, async () => {
    attempts += 1;
    if (attempts === 1) {
      // ListenBrainz answers 429 once the 30/minute window is exhausted and
      // reports when that window resets.
      throw Object.assign(new Error("Request failed with status code 429"), {
        response: {
          status: 429,
          data: { error: "You have exceeded your rate limit." },
          headers: {
            "x-ratelimit-reset": String(
              Math.floor(Date.now() / 1000) + 1,
            ),
          },
        },
      });
    }
    return { status: 200, data: { ok: true } };
  });

  const { listenbrainzRequest } = await importFromRepo(
    "backend/services/apiClients/listenbrainz.js",
  );
  const result = await listenbrainzRequest("/1/test-retry-after-429", {
    unique: "429-retry",
  });

  assert.equal(attempts, 2, "expected the 429 to be retried");
  assert.deepEqual(result, { ok: true });
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
  const radioCalls = [];
  mockListenbrainzOnly(t, async (url, options) => {
    const seedMbid = String(url).split("/artist/")[1]?.split("?")[0] || "";
    radioCalls.push({ seedMbid, params: options?.params || {} });
    const similarMbid = seedMbid === SEED_MBID ? SIMILAR_MBID : SIMILAR_MBID_2;
    const similarName = seedMbid === SEED_MBID ? "Similar Artist" : "Another Artist";
    return {
      status: 200,
      data: {
        [similarMbid]: [
          {
            recording_mbid: "55555555-5555-4555-8555-555555555555",
            similar_artist_mbid: similarMbid,
            similar_artist_name: similarName,
            total_listen_count: 40000,
          },
        ],
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
    // Every seed must reach LB Radio with the mandatory popularity bounds,
    // otherwise the endpoint 400s and contributes no recommendations at all.
    assert.equal(radioCalls.length, 2, "expected one radio call per seed");
    assert.ok(
      radioCalls.every(
        (call) => call.params.pop_begin === 0 && call.params.pop_end === 100,
      ),
      JSON.stringify(radioCalls),
    );
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

test("editorial playlists build from listenbrainz tags without a lastfm key", async (t) => {
  const recA = "1a1a1a1a-0001-4a1a-8a1a-1a1a1a1a1a01";
  const recB = "1b1b1b1b-0002-4b1b-8b1b-1b1b1b1b1b02";
  const releaseMbid = "1c1c1c1c-0003-4c1c-8c1c-1c1c1c1c1c03";

  const tagTimeouts = [];
  mockListenbrainzOnly(t, async (url, options) => {
    const target = String(url);
    // Recording metadata is fetched by Lucene search on rid:, not a semicolon
    // path lookup, so match the query param rather than the URL path.
    const ridQuery = String(options?.params?.query || "");
    if (ridQuery.startsWith("rid:")) {
      const ids = [...ridQuery.matchAll(/\(([0-9a-f-]{36})\)/gi)].map((m) => m[1].toLowerCase());
      return {
        status: 200,
        data: {
          recordings: ids.map((id) => ({
            id,
            title: id === recA ? "First Track" : "Second Track",
            "artist-credit": [
              { name: "Tag Artist", artist: { id: SIMILAR_MBID } },
            ],
            releases: [{ id: releaseMbid, title: "Tag Album", date: "2021-05-04" }],
            length: 210000,
          })),
        },
      };
    }
    assert.match(target, /\/1\/lb-radio\/tags/);
    tagTimeouts.push(options?.timeout);
    return {
      status: 200,
      data: [
        { recording_mbid: recA, total_listen_count: 900 },
        { recording_mbid: recB, total_listen_count: 400 },
      ],
    };
  });

  const { generateEditorialPlaylists } = await importFromRepo(
    "backend/services/discovery/editorialPlaylistBuilder.js",
  );
  const playlists = await generateEditorialPlaylists();

  assert.ok(playlists.length > 0, "expected editorial playlists without a lastfm key");
  const playlist = playlists[0];
  assert.equal(playlist.type, "editorial");
  assert.equal(playlist.trackCount, playlist.tracks.length);
  assert.ok(playlist.tracks.length > 0);
  assert.equal(playlist.tracks[0].artistName, "Tag Artist");
  assert.equal(playlist.tracks[0].trackName, "First Track");
  // Album names come from MusicBrainz metadata, not a Last.fm track.getInfo call.
  assert.equal(playlist.tracks[0].albumName, "Tag Album");
  // Reason copy must not claim a Last.fm ranking.
  assert.doesNotMatch(playlist.tracks[0].reason, /Last\.fm/);
  // The LB tag endpoint regularly takes 5-30s, so it must not inherit the
  // 6s default timeout or every editorial playlist comes back empty.
  assert.ok(tagTimeouts.length > 0, "expected at least one tag request");
  assert.ok(
    tagTimeouts.every((timeout) => timeout >= 30000),
    `tag timeout too small: ${JSON.stringify(tagTimeouts)}`,
  );
});

test("editorial playlists are skipped when the editorial toggle is off", async (t) => {
  const recA = "2a2a2a2a-0004-4a2a-8a2a-2a2a2a2a2a04";
  let tagRequests = 0;
  mockListenbrainzOnly(t, async (url) => {
    const target = String(url);
    if (target.includes("/1/lb-radio/tags")) {
      tagRequests += 1;
      return { status: 200, data: [{ recording_mbid: recA, total_listen_count: 900 }] };
    }
    return { status: 200, data: {} };
  });

  dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      ...(dbOps.getSettings().integrations || {}),
      lastfm: {
        ...(dbOps.getSettings().integrations?.lastfm || {}),
        discoveryEditorialEnabled: false,
      },
    },
  });
  dbOps.invalidateSettingsCache();

  const { isDiscoveryEditorialEnabled } = await importFromRepo(
    "backend/services/discovery/helpers.js",
  );
  assert.equal(isDiscoveryEditorialEnabled(), false);

  const { generateDiscoverPlaylists } = await importFromRepo(
    "backend/services/discovery/playlistBuilder.js",
  );
  const playlists = await generateDiscoverPlaylists({
    discoveryCache: { recommendations: [], globalTop: [], basedOn: [], topGenres: [], topTags: [] },
    basedOn: [],
    topGenres: [],
    topTags: [],
    recommendations: [],
    globalTop: [],
    libraryArtists: [],
    libraryArtistKeys: new Set(),
  });

  assert.equal(tagRequests, 0, "editorial tag lookups should not run when disabled");
  assert.ok(
    playlists.every((playlist) => playlist.type !== "editorial"),
    "no editorial playlists should be produced",
  );
});

test("global refresh on the listenbrainz path does not hit a temporal dead zone", async (t) => {
  const seedMbid = "9a9a9a9a-1111-4111-8111-111111111111";
  const similarMbid = "9b9b9b9b-2222-4222-8222-222222222222";
  const recMbid = "9c9c9c9c-3333-4333-8333-333333333333";
  const releaseMbid = "9d9d9d9d-4444-4444-8444-444444444444";

  db.prepare(
    `INSERT INTO users (username, password_hash, role, listen_history_provider, listen_history_username)
     VALUES ('lb-refresh', 'hash', 'user', 'listenbrainz', 'lb-listener')`,
  ).run();

  const server = await createMockHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.includes("/recording/")) {
      response.end(
        JSON.stringify({
          recordings: [
            {
              id: recMbid,
              title: "Radio Track",
              "artist-credit": [{ name: "Radio Artist", artist: { id: similarMbid } }],
              releases: [{ id: releaseMbid, title: "Radio Album", date: "2024-01-02" }],
              length: 180000,
            },
          ],
        }),
      );
      return;
    }
    const mbid = String(request.url || "").split("/").pop() || "";
    response.end(JSON.stringify({ id: mbid, name: "Seed", genres: ["indie rock"] }));
  });
  const previousSettings = pointMetadataProviderAt(server.url);
  clearMetadataProviderCaches();

  t.after(async () => {
    dbOps.updateSettings(previousSettings);
    clearMetadataProviderCaches();
    await server.close();
  });

  mockListenbrainzOnly(t, async (url) => {
    const target = String(url);
    if (target.includes("/1/stats/user/")) {
      return {
        status: 200,
        data: {
          payload: {
            artists: [
              {
                artist_name: "Seed Artist",
                artist_mbids: [seedMbid],
                listen_count: 5000,
              },
            ],
          },
        },
      };
    }
    if (target.includes("/1/stats/sitewide/artists")) {
      return {
        status: 200,
        data: {
          payload: {
            artists: [
              { artist_name: "Trending One", artist_mbids: [similarMbid], listen_count: 900 },
            ],
          },
        },
      };
    }
    if (target.includes("/1/lb-radio/artist/")) {
      return {
        status: 200,
        data: {
          [similarMbid]: [
            {
              recording_mbid: recMbid,
              similar_artist_mbid: similarMbid,
              similar_artist_name: "Radio Artist",
              total_listen_count: 12000,
            },
          ],
        },
      };
    }
    return { status: 200, data: [] };
  });

  const { updateDiscoveryCache } = await importFromRepo(
    "backend/services/discovery/provider.js",
  );

  // This is the exact production path that crashed with
  // "Cannot access 'existingArtistKeys' before initialization": the
  // ListenBrainz branch reads existingArtistKeys before its declaration.
  // updateDiscoveryCache swallows failures and returns undefined, so assert on
  // the persisted result rather than on a return value.
  await updateDiscoveryCache({ skipHonkerLock: true });

  const cached = dbOps.getDiscoveryCache();
  assert.equal(
    cached.provider,
    DISCOVERY_PROVIDER_LISTENBRAINZ,
    "global refresh should persist the listenbrainz provider",
  );
  assert.ok(
    cached.recommendations.length > 0,
    "expected listenbrainz recommendations from the history profile",
  );
  assert.ok(cached.lastUpdated, "expected a refresh timestamp");
});

test("global refresh schedules the discover playlist build on the listenbrainz path", async (t) => {
  const seedMbid = "7a7a7a7a-1111-4111-8111-111111111111";
  const similarMbid = "7b7b7b7b-2222-4222-8222-222222222222";
  const recMbid = "7c7c7c7c-3333-4333-8333-333333333333";
  const releaseMbid = "7d7d7d7d-4444-4444-8444-444444444444";

  db.prepare(
    `INSERT INTO users (username, password_hash, role, listen_history_provider, listen_history_username)
     VALUES ('lb-playlist', 'hash', 'user', 'listenbrainz', 'lb-listener')`,
  ).run();

  // Keep the queued job from being claimed by an in-process worker so the
  // assertion is deterministic.
  const previousGroup = process.env.AURRAL_BACKGROUND_WORKER_GROUP;
  process.env.AURRAL_BACKGROUND_WORKER_GROUP = "flow";

  const server = await createMockHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.includes("/recording/")) {
      response.end(
        JSON.stringify({
          recordings: [
            {
              id: recMbid,
              title: "Radio Track",
              "artist-credit": [{ name: "Radio Artist", artist: { id: similarMbid } }],
              releases: [{ id: releaseMbid, title: "Radio Album", date: "2024-01-02" }],
              length: 180000,
            },
          ],
        }),
      );
      return;
    }
    const mbid = String(request.url || "").split("/").pop() || "";
    response.end(JSON.stringify({ id: mbid, name: "Seed", genres: ["indie rock"] }));
  });
  const previousSettings = pointMetadataProviderAt(server.url);
  clearMetadataProviderCaches();

  t.after(async () => {
    if (previousGroup === undefined) {
      delete process.env.AURRAL_BACKGROUND_WORKER_GROUP;
    } else {
      process.env.AURRAL_BACKGROUND_WORKER_GROUP = previousGroup;
    }
    dbOps.updateSettings(previousSettings);
    clearMetadataProviderCaches();
    await server.close();
  });

  mockListenbrainzOnly(t, async (url) => {
    const target = String(url);
    if (target.includes("/1/stats/user/")) {
      return {
        status: 200,
        data: {
          payload: {
            artists: [
              { artist_name: "Seed Artist", artist_mbids: [seedMbid], listen_count: 5000 },
            ],
          },
        },
      };
    }
    if (target.includes("/1/lb-radio/artist/")) {
      return {
        status: 200,
        data: {
          [similarMbid]: [
            {
              recording_mbid: recMbid,
              similar_artist_mbid: similarMbid,
              similar_artist_name: "Radio Artist",
              total_listen_count: 12000,
            },
          ],
        },
      };
    }
    return { status: 200, data: [] };
  });

  const { updateDiscoveryCache } = await importFromRepo(
    "backend/services/discovery/provider.js",
  );
  const { listHonkerJobs } = await importFromRepo("backend/services/honkerDb.js");

  const beforeCount = listHonkerJobs("discovery-playlist-build").length;

  // The ListenBrainz branch returns before the shared tail that enqueues the
  // playlist build, so it has to enqueue one itself. Without it, Discover
  // playlists stay permanently empty for ListenBrainz-only users.
  await updateDiscoveryCache({ skipHonkerLock: true });

  const queued = listHonkerJobs("discovery-playlist-build");
  assert.equal(
    queued.length,
    beforeCount + 1,
    "expected the discover playlist build to be enqueued",
  );
  assert.ok(
    queued[queued.length - 1].payload?.buildToken,
    "expected a build token on the job",
  );
});
