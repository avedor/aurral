import test from "node:test";
import assert from "node:assert/strict";

import { getFlowCapabilities } from "../../backend/services/listenbrainzDiscoveryFallback.js";
import {
  isValidMbid,
  flattenRadioEntries,
  filterRadioEntriesByArtist,
} from "../../backend/services/weeklyFlow/listenbrainzFlowData.js";
import { getLastfmApiKey } from "../../backend/services/apiClients/index.js";
import { getUnavailableFlowSourceError } from "../../backend/services/weeklyFlow/weeklyFlowValidation.js";
import { WeeklyFlowPlaylistSource } from "../../backend/services/weeklyFlow/weeklyFlowPlaylistSource.js";

const setFlowEnv = ({ lastfmKey = undefined, disableListenbrainz = false } = {}) => {
  if (lastfmKey) {
    process.env.LASTFM_API_KEY = lastfmKey;
  } else {
    delete process.env.LASTFM_API_KEY;
  }
  if (disableListenbrainz) {
    process.env.DISABLE_LISTENBRAINZ_FLOWS = "1";
  } else {
    delete process.env.DISABLE_LISTENBRAINZ_FLOWS;
  }
};

test("flow capabilities enable all sources without a Last.fm key via ListenBrainz", () => {
  setFlowEnv({ lastfmKey: undefined, disableListenbrainz: false });
  const capabilities = getFlowCapabilities(false);
  assert.equal(capabilities.lastfmRequired, false);
  assert.equal(capabilities.listenbrainzBased, true);
  assert.deepEqual(capabilities.availableSources, ["discover", "mix", "trending", "focus"]);
  assert.deepEqual(capabilities.unavailableSources, {});
});

test("flow capabilities keep the Last.fm path when a key is configured", () => {
  setFlowEnv({ lastfmKey: undefined, disableListenbrainz: false });
  const capabilities = getFlowCapabilities(true);
  assert.equal(capabilities.lastfmRequired, false);
  assert.equal(capabilities.listenbrainzBased, false);
  assert.deepEqual(capabilities.availableSources, ["discover", "mix", "trending", "focus"]);
  assert.deepEqual(capabilities.unavailableSources, {});
});

test("flow capabilities report all sources unavailable without a key and with ListenBrainz disabled", () => {
  setFlowEnv({ lastfmKey: undefined, disableListenbrainz: true });
  const capabilities = getFlowCapabilities(false);
  assert.equal(capabilities.listenbrainzBased, false);
  assert.deepEqual(capabilities.availableSources, []);
  for (const source of ["discover", "mix", "trending", "focus"]) {
    assert.ok(capabilities.unavailableSources[source]);
  }
});

test("validation does not gate flow sources when a Last.fm key is configured", () => {
  setFlowEnv({ lastfmKey: "test-key", disableListenbrainz: true });
  assert.equal(getUnavailableFlowSourceError({ discover: 50 }), null);
  assert.equal(getUnavailableFlowSourceError({ trending: 50 }), null);
  assert.equal(getUnavailableFlowSourceError({ focus: 50 }), null);
  assert.equal(getUnavailableFlowSourceError({ mix: 50 }), null);
});

test("validation does not gate flow sources without a key when ListenBrainz flows are enabled", () => {
  setFlowEnv({ lastfmKey: undefined, disableListenbrainz: false });
  assert.equal(getUnavailableFlowSourceError({ discover: 34, mix: 33, trending: 33 }), null);
});

test("validation keeps old Last.fm-only gating when ListenBrainz flows are disabled", () => {
  setFlowEnv({ lastfmKey: undefined, disableListenbrainz: true });
  assert.ok(getUnavailableFlowSourceError({ discover: 1 }).includes("Last.fm"));
  assert.ok(getUnavailableFlowSourceError({ trending: 1 }).includes("Last.fm"));
  assert.ok(getUnavailableFlowSourceError({ focus: 1 }).includes("Last.fm"));
  assert.ok(getUnavailableFlowSourceError({ mix: 1 }).includes("Last.fm"));
  assert.equal(getUnavailableFlowSourceError({}), null);
});

test("listenbrainz mbid validation rejects malformed values", () => {
  assert.equal(
    isValidMbid("cb67438a-7f50-4f2b-a6f1-2bb2729fd538"),
    true,
  );
  assert.equal(isValidMbid("not-an-mbid"), false);
  assert.equal(isValidMbid(""), false);
  assert.equal(isValidMbid(null), false);
});

test("flattenRadioEntries dedupes recordings and maps artist fields", () => {
  const radio = {
    "Boo Hoo Boys": [
      { recording_mbid: "401c1a5d-56e7-434d-b07e-a14d4e7eb83c", similar_artist_mbid: "cb67438a-7f50-4f2b-a6f1-2bb2729fd538", similar_artist_name: "Boo Hoo Boys", total_listen_count: 232361 },
      { recording_mbid: "401c1a5d-56e7-434d-b07e-a14d4e7eb83c", similar_artist_mbid: "some-other", similar_artist_name: "Other", total_listen_count: 1 },
    ],
    "Seed": [
      { recording_mbid: "9e59c0a5-8e2c-4f0c-9a3b-4b8c2d1a5f0e", similar_artist_mbid: "seed-mbid-uuid", similar_artist_name: "Seed", total_listen_count: 12 },
    ],
  };
  const entries = flattenRadioEntries(radio);
  assert.equal(entries.length, 2);
  const first = entries.find((entry) => entry.recordingMbid === "401c1a5d-56e7-434d-b07e-a14d4e7eb83c");
  assert.equal(first.artistName, "Boo Hoo Boys");
  assert.equal(first.listenCount, 232361);
});

test("filterRadioEntriesByArtist returns only the seed artist recordings", () => {
  const entries = flattenRadioEntries({
    "Boo Hoo Boys": [
      { recording_mbid: "401c1a5d-56e7-434d-b07e-a14d4e7eb83c", similar_artist_mbid: "cb67438a-7f50-4f2b-a6f1-2bb2729fd538", similar_artist_name: "Boo Hoo Boys", total_listen_count: 232361 },
    ],
    "Seed": [
      { recording_mbid: "9e59c0a5-8e2c-4f0c-9a3b-4b8c2d1a5f0e", similar_artist_mbid: "9e59c0a5-8e2c-4f0c-9a3b-4b8c2d1a5f0e", similar_artist_name: "Seed", total_listen_count: 12 },
    ],
  });
  const seedOnly = filterRadioEntriesByArtist(entries, "9e59c0a5-8e2c-4f0c-9a3b-4b8c2d1a5f0e");
  assert.equal(seedOnly.length, 1);
  assert.equal(seedOnly[0].recordingMbid, "9e59c0a5-8e2c-4f0c-9a3b-4b8c2d1a5f0e");
});

test("discover falls back to genre/globalTop pools in ListenBrainz mode", async () => {
  setFlowEnv({ lastfmKey: undefined, disableListenbrainz: false });
  const source = new WeeklyFlowPlaylistSource();
  source._harvestTopTracksFromArtists = async (artists) => artists;

  const tracks = await source.getDiscoverTracks(3, {
    discoveryCache: {
      recommendations: [],
      globalTop: [{ name: "Global Artist" }],
      fallbackGenres: [
        { name: "Rock", artists: [{ name: "Radiohead" }, { name: "Nirvana", artistMbid: "nirvana-mbid" }] },
      ],
      fallbackGenrePools: { Rock: [{ name: "David Bowie", artistMbid: "bowie-mbid" }] },
    },
  });

  const names = tracks.map((track) => track.name).sort();
  assert.deepEqual(names, ["David Bowie", "Global Artist", "Nirvana", "Radiohead"]);
});

test("discover uses recommendations when present even without a Last.fm key", async () => {
  setFlowEnv({ lastfmKey: undefined, disableListenbrainz: false });
  const source = new WeeklyFlowPlaylistSource();
  source._harvestTopTracksFromArtists = async (artists) => artists;

  const tracks = await source.getDiscoverTracks(1, {
    discoveryCache: {
      recommendations: [{ name: "Recommended Artist" }],
      globalTop: [],
      fallbackGenres: [],
    },
  });

  assert.equal(tracks[0]?.name, "Recommended Artist");
});

test("discover keeps rejecting empty caches", async () => {
  setFlowEnv({ lastfmKey: undefined, disableListenbrainz: false });
  const source = new WeeklyFlowPlaylistSource();
  await assert.rejects(
    source.getDiscoverTracks(1, {
      discoveryCache: { recommendations: [], globalTop: [], fallbackGenres: [] },
    }),
    /No discovery recommendations/,
  );
});

test("mix album pick skips the Last.fm getInfo fallback without a key", async () => {
  setFlowEnv({ lastfmKey: undefined, disableListenbrainz: false });
  const source = new WeeklyFlowPlaylistSource();
  let viaInfoCalls = 0;
  source._pickTrackFromRangesWithOwnedAlbumsViaInfo = async () => {
    viaInfoCalls += 1;
    throw new Error("should not hit Last.fm");
  };
  const picked = await source._pickTrackFromRangesWithOwnedAlbums(
    [{ name: "Only Track" }],
    new Set(),
    new Set(["owned release"]),
    "Some Artist",
    [{ start: 0, end: 10 }],
  );
  assert.equal(picked, null);
  assert.equal(viaInfoCalls, 0);
  assert.equal(getLastfmApiKey(), undefined);
});

test("mix album pick still uses the Last.fm getInfo fallback with a key", async () => {
  setFlowEnv({ lastfmKey: "test-key", disableListenbrainz: false });
  const source = new WeeklyFlowPlaylistSource();
  let viaInfoCalls = 0;
  source._pickTrackFromRangesWithOwnedAlbumsViaInfo = async () => {
    viaInfoCalls += 1;
    return { pick: { name: "Via Info Track" }, albumName: "Discovered Release" };
  };
  const picked = await source._pickTrackFromRangesWithOwnedAlbums(
    [{ name: "Only Track" }],
    new Set(),
    new Set(["owned release"]),
    "Some Artist",
    [{ start: 0, end: 10 }],
  );
  assert.equal(viaInfoCalls, 1);
  assert.equal(picked?.pick?.name, "Via Info Track");
});