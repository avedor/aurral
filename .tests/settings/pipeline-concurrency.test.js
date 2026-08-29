import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { dbOps }, worker] =
  await setupIsolatedBackend(
    "pipeline-concurrency-precedence",
    "backend/config/db-sqlite.js",
    "backend/db/helpers/index.js",
    "backend/services/slskdOrchestratorWorker.js",
  );

test.beforeEach(() => {
  resetDatabase(db);
});

test.after(() => cleanupIsolatedState(isolatedState));

test("GUI pipeline setting takes precedence, then env, then default", () => {
  const envKey = "AURRAL_PIPELINE_CONCURRENCY";
  const original = process.env[envKey];

  try {
    delete process.env[envKey];

    const noStoredNoEnv = worker.resolvePipelineConcurrency();
    assert.equal(noStoredNoEnv, 4);

    dbOps.setJSONSetting("pipeline", { concurrency: 9 });
    const stored = worker.resolvePipelineConcurrency();
    assert.equal(stored, 9);

    process.env[envKey] = "2";
    const storedWithEnv = worker.resolvePipelineConcurrency();
    assert.equal(storedWithEnv, 9, "GUI stored value wins over env var");

    db.prepare("DELETE FROM settings WHERE key = 'pipeline'").run();
    const envOnly = worker.resolvePipelineConcurrency();
    assert.equal(envOnly, 2);

    process.env[envKey] = "999";
    assert.equal(worker.resolvePipelineConcurrency(), 16);
  } finally {
    if (original === undefined) delete process.env[envKey];
    else process.env[envKey] = original;
  }
});
