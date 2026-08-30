import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps }, { registerGeneral }, { playlistManager }] =
  await setupIsolatedBackend(
    "general-settings",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/routes/settings/handlers/general.js",
    "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
  );

test.beforeEach(() => {
  resetDatabase(db);
  dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
});

test.after(() => cleanupIsolatedState(isolatedState));

test("schedules the library scan after playlist initialization settles", async () => {
  const events = [];
  let releaseInitialization;
  const initialization = new Promise((resolve) => {
    releaseInitialization = resolve;
  });
  const originalUpdateConfig = playlistManager.updateConfig;
  const originalEnsureSmartPlaylists = playlistManager.ensureSmartPlaylists;
  const originalScheduleScanLibrary = playlistManager.scheduleScanLibrary;

  try {
    playlistManager.updateConfig = () => {};
    playlistManager.ensureSmartPlaylists = async () => {
      events.push("ensure-start");
      await initialization;
      events.push("ensure-end");
    };
    playlistManager.scheduleScanLibrary = () => {
      events.push("scan");
    };

    const routes = {};
    registerGeneral({
      get(path, ...handlers) {
        routes[`GET ${path}`] = handlers.at(-1);
      },
      post(path, ...handlers) {
        routes[`POST ${path}`] = handlers.at(-1);
      },
    });

    let statusCode = 200;
    let responseBody;
    const response = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        responseBody = body;
        return this;
      },
    };
    const handlerPromise = routes["POST /"](
      {
        body: { integrations: { jellyfin: { url: "", apiKey: "", userId: "" } } },
        user: { id: 1 },
      },
      response,
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["ensure-start"]);

    releaseInitialization();
    await handlerPromise;
    assert.equal(statusCode, 200);
    assert.ok(responseBody);
    assert.deepEqual(events, ["ensure-start", "ensure-end", "scan"]);
  } finally {
    playlistManager.updateConfig = originalUpdateConfig;
    playlistManager.ensureSmartPlaylists = originalEnsureSmartPlaylists;
    playlistManager.scheduleScanLibrary = originalScheduleScanLibrary;
  }
});

test("pipeline concurrency persists and clamps to the allowed range", async () => {
  const routes = {};
  registerGeneral({
    get(path, ...handlers) {
      routes[`GET ${path}`] = handlers.at(-1);
    },
    post(path, ...handlers) {
      routes[`POST ${path}`] = handlers.at(-1);
    },
  });

  const callPost = async (body) => {
    let statusCode = 200;
    let responseBody;
    const response = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(bodyValue) {
        responseBody = bodyValue;
        return this;
      },
    };
    await routes["POST /"](
      { body, user: { id: 1 } },
      response,
    );
    return { statusCode, responseBody };
  };

  const post = await callPost({ pipeline: { concurrency: 7 } });
  assert.equal(post.statusCode, 200);
  assert.equal(dbOps.getSettings().pipeline.concurrency, 7);

  const outOfRange = await callPost({ pipeline: { concurrency: 999 } });
  assert.equal(outOfRange.statusCode, 200);
  assert.equal(dbOps.getSettings().pipeline.concurrency, 16);

  const negative = await callPost({ pipeline: { concurrency: -3 } });
  assert.equal(negative.statusCode, 200);
  assert.equal(dbOps.getSettings().pipeline.concurrency, 1);
});
