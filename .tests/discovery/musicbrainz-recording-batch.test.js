import test from "node:test";
import assert from "node:assert/strict";

import axios from "../../lib/axiosFetch.js";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
  importFromRepo,
} from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps }] = await setupIsolatedBackend(
  "musicbrainz-recording-batch",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
);

const { musicbrainzGetRecordingsByIds } = await importFromRepo(
  "backend/services/apiClients/musicbrainz.js",
);

const MBID_A = "11111111-1111-4111-8111-111111111111";
const MBID_B = "22222222-2222-4222-8222-222222222222";
const MBID_C = "33333333-3333-4333-8333-333333333333";

const recording = (id, title) => ({
  id,
  title,
  length: 210000,
  "artist-credit": [{ name: "Artist", artist: { id: MBID_C } }],
  releases: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      title: "Some Album",
      date: "2001-01-01",
    },
  ],
});

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.invalidateSettingsCache();
});
test.after(() => cleanupIsolatedState(state));

// MusicBrainz rejects semicolon-batched path lookups on /ws/2/recording/ with
// 400 "Invalid mbid.". These tests pin the search-based batching instead, and
// deliberately fail if the semicolon path form comes back.
test("batched recording lookup uses rid: search and parses artist-credit and releases", async (t) => {
  const requests = [];
  t.mock.method(axios, "get", async (url, options) => {
    const target = String(url);
    requests.push({ url: target, params: options?.params });
    // Reject the old path form the way the live API does.
    if (/\/recording\/[0-9a-f-]+(;|$)/i.test(target)) {
      const error = new Error("Request failed with status code 400");
      error.response = { status: 400, data: { error: "Invalid mbid." } };
      error.code = undefined;
      throw error;
    }
    const query = String(options?.params?.query || "");
    const ids = [...query.matchAll(/\(([0-9a-f-]{36})\)/gi)].map((m) => m[1].toLowerCase());
    return {
      status: 200,
      data: {
        created: "2026-01-01T00:00:00.000Z",
        count: ids.length,
        offset: 0,
        recordings: ids.map((id, i) => recording(id, `Track ${i + 1}`)),
      },
    };
  });

  const resolved = await musicbrainzGetRecordingsByIds([MBID_A, MBID_B]);

  assert.equal(resolved.length, 2, "both recordings should resolve");
  assert.deepEqual(
    resolved.map((r) => r.trackMbid.toLowerCase()).sort(),
    [MBID_A, MBID_B].sort(),
  );
  assert.equal(resolved[0].artistName, "Artist");
  assert.equal(resolved[0].artistMbid, MBID_C);
  assert.equal(resolved[0].releaseName, "Some Album");
  assert.equal(resolved[0].durationMs, 210000);

  const lookup = requests.find((r) => !/\/recording\/[0-9a-f-]+(;|$)/i.test(r.url));
  assert.ok(lookup, "should issue a non-semicolon recording lookup");
  assert.match(lookup.params.query, /^rid:\(/);
  assert.ok(lookup.params.query.includes(MBID_A));
  assert.equal(lookup.params.inc, "artist-credits+releases");
});

test("recording lookup batches into chunks of ten", async (t) => {
  const batchSizes = [];
  t.mock.method(axios, "get", async (_url, options) => {
    const query = String(options?.params?.query || "");
    const ids = [...query.matchAll(/\(([0-9a-f-]{36})\)/gi)].map((m) => m[1].toLowerCase());
    batchSizes.push(ids.length);
    return {
      status: 200,
      data: { count: ids.length, offset: 0, recordings: ids.map((id) => recording(id, "T")) },
    };
  });

  const many = Array.from(
    { length: 23 },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  );
  const resolved = await musicbrainzGetRecordingsByIds(many);

  assert.equal(resolved.length, 23, "all recordings should resolve");
  assert.deepEqual(batchSizes, [10, 10, 3]);
});

test("recordings absent from MusicBrainz are skipped without failing the batch", async (t) => {
  // Fresh ids: musicbrainzRecordingCache is module-level and survives between
  // tests in this file.
  const presentId = "55555555-5555-4555-8555-555555555555";
  const absentId = "66666666-6666-4666-8666-666666666666";
  t.mock.method(axios, "get", async (_url, options) => {
    const query = String(options?.params?.query || "");
    const ids = [...query.matchAll(/\(([0-9a-f-]{36})\)/gi)].map((m) => m[1].toLowerCase());
    // Only one id exists, mirroring real merged/deleted recordings.
    const present = ids.includes(presentId) ? [recording(presentId, "Only Track")] : [];
    return { status: 200, data: { count: present.length, offset: 0, recordings: present } };
  });

  const resolved = await musicbrainzGetRecordingsByIds([presentId, absentId]);

  assert.equal(resolved.length, 1, "missing recordings are dropped, not faked");
  assert.equal(resolved[0].trackMbid.toLowerCase(), presentId);
});