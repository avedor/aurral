import test from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps }, persistedDiscovery, { getUserDiscovery }, discovery] = await setupIsolatedBackend(
  "user-discovery", "backend/config/db-sqlite.js", "backend/db/helpers/index.js",
  "backend/services/discovery/persistence.js", "backend/services/discovery/userDiscovery.js", "backend/services/discovery/index.js",
);

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.invalidateSettingsCache();
});
test.after(() => cleanupIsolatedState(state));

test("cached discovery excludes library identities and paginates the remaining recommendations", async () => {
  db.prepare(`INSERT INTO library_artists (id, identity_key, mbid, name, metadata_json, created_at, updated_at)
    VALUES (41, 'provider-key', 'library-mbid', 'Library Artist', ?, 1, 1)`)
    .run(JSON.stringify({ foreignArtistId: "provider-id" }));
  dbOps.updateDiscoveryCache({
    recommendations: [
      { id: "41", name: "Canonical Alias" }, { id: "library-mbid", name: "Mbid Alias" },
      { foreignArtistId: "provider-id", name: "Provider Alias" }, { name: "library artist" },
      { id: "first", name: "First", scoreTotal: 10 }, { id: "second", name: "Second", scoreTotal: 1 },
    ], globalTop: [{ name: "Library Artist" }, { name: "Global" }],
  });
  persistedDiscovery.reloadDiscoveryPersistedCache();
  const { body } = await getUserDiscovery(7, 1, 1);
  assert.equal(body.recommendationCount, 2);
  assert.deepEqual(body.recommendations.map((artist) => artist.name), ["Second"]);
  assert.deepEqual(body.globalTop.map((artist) => artist.name), ["Global"]);
  db.prepare("DELETE FROM library_artists").run();
  assert.equal((await getUserDiscovery(7, 0)).body.recommendationCount, 6);
});

test("cached discovery applies per-user blocks to fallback sections and playlist aliases", async () => {
  dbOps.updateDiscoveryCache({
    recommendations: [{ name: "Allowed" }, { name: "Blocked" }],
    globalTop: [{ name: "Blocked" }],
    fallbackGenres: [{ name: "Genre", artists: [{ name: "Blocked" }, { name: "Allowed" }] }],
    discoverPlaylists: [
      { presetId: "mixed", tracks: [{ artistName: "Alias", artistAliases: ["Blocked"] }, { artistName: "Allowed", trackName: "Keep" }] },
      { presetId: "empty", tracks: [{ artistName: "Blocked", trackName: "Hide" }] },
    ],
  });
  persistedDiscovery.reloadDiscoveryPersistedCache();
  const block = discovery.addDiscoveryFeedback(7, { artistName: "Blocked", action: "block_artist" });
  const { body } = await getUserDiscovery(7, 0);
  assert.deepEqual(body.recommendations.map((artist) => artist.name), ["Allowed"]);
  assert.equal(body.globalTop.length, 0);
  assert.deepEqual(body.fallbackGenres[0].artists.map((artist) => artist.name), ["Allowed"]);
  assert.deepEqual(body.discoverPlaylists.map((playlist) => [playlist.presetId, playlist.trackCount]), [["mixed", 1]]);
  assert.equal((await getUserDiscovery(8, 0)).body.discoverPlaylists.length, 2);
  discovery.removeDiscoveryFeedback(7, block.id);
  assert.equal((await getUserDiscovery(7, 0)).body.discoverPlaylists.length, 2);
});

test("a listenbrainz listening-history user gets personalized discovery without a lastfm key", async () => {
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, listen_history_provider, listen_history_username)
     VALUES (7, 'lb-user', 'hash', 'user', 'listenbrainz', 'lb-listener')`,
  ).run();
  dbOps.updateDiscoveryCache({
    recommendations: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Recommended" }],
    basedOn: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Seed" }],
    provider: "listenbrainz",
  });
  persistedDiscovery.reloadDiscoveryPersistedCache();

  const { body } = await getUserDiscovery(7, 0);
  assert.equal(body.provider, "listenbrainz");
  assert.equal(body.capabilities.personalizedRecommendations, true);
  assert.equal(body.listenbrainzHistoryConfigured, true);
  assert.deepEqual(body.recommendations.map((artist) => artist.name), ["Recommended"]);
});

test("the fallback provider upgrades to listenbrainz once a history profile exists", async () => {
  dbOps.updateDiscoveryCache({ recommendations: [], provider: "listenbrainz-fallback" });
  persistedDiscovery.reloadDiscoveryPersistedCache();
  const before = await getUserDiscovery(7, 0);
  assert.equal(before.body.provider, "listenbrainz-fallback");
  assert.equal(before.body.capabilities.personalizedRecommendations, false);

  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, listen_history_provider, listen_history_username)
     VALUES (7, 'lb-user', 'hash', 'user', 'listenbrainz', 'lb-listener')`,
  ).run();
  const after = await getUserDiscovery(7, 0);
  assert.equal(after.body.provider, "listenbrainz");
  assert.equal(after.body.capabilities.personalizedRecommendations, true);
});
