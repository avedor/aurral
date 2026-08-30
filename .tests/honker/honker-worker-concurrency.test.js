import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

process.env.NODE_ENV = "test";

const [{ default: createHonkerWorker }] = await Promise.all([
  import("../../backend/services/honkerWorkerFactory.js"),
]);

const makeJob = (n) => ({
  id: n,
  attempts: 0,
  payload: { n },
  ack() {},
  fail() {},
  retry() {},
  heartbeat() {},
});

test("pipeline worker processes jobs concurrently up to the concurrency limit", async () => {
  const pending = Array.from({ length: 12 }, (_, index) => index + 1);
  const queue = {
    maxAttempts: 1,
    visibilityTimeoutS: 30,
    async *claim() {
      while (pending.length > 0) {
        yield makeJob(pending.shift());
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    },
  };

  const inFlight = new Set();
  let maxActive = 0;
  const worker = createHonkerWorker({
    name: "concurrency-limit-test",
    getQueue: () => queue,
    concurrency: 3,
    idlePollS: 1,
    processJob: async (payload) => {
      inFlight.add(payload.n);
      maxActive = Math.max(maxActive, inFlight.size);
      await delay(50);
      inFlight.delete(payload.n);
    },
  });

  worker.start();
  await delay(600);
  await worker.stop();

  assert.ok(maxActive >= 2, `expected parallel processing, got maxActive=${maxActive}`);
  assert.ok(maxActive <= 3, `expected concurrency to cap at 3, got ${maxActive}`);
});

test("worker with concurrency 1 stays sequential", async () => {
  const pending = Array.from({ length: 5 }, (_, index) => index + 1);
  const queue = {
    maxAttempts: 1,
    visibilityTimeoutS: 30,
    async *claim() {
      while (pending.length > 0) {
        yield makeJob(pending.shift());
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    },
  };

  const activeCounts = [];
  let active = 0;
  const worker = createHonkerWorker({
    name: "sequential-test",
    getQueue: () => queue,
    concurrency: 1,
    idlePollS: 1,
    processJob: async () => {
      active += 1;
      activeCounts.push(active);
      await delay(30);
      active -= 1;
    },
  });

  worker.start();
  await delay(400);
  await worker.stop();

  assert.ok(activeCounts.length > 0);
  assert.ok(activeCounts.every((count) => count === 1), "jobs should run one at a time");
});

test("stop waits for all concurrent loops and resolves", async () => {
  let release;
  const workStarted = Promise.withResolvers();
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pending = [1, 2, 3, 4];
  const queue = {
    maxAttempts: 1,
    visibilityTimeoutS: 30,
    async *claim(workerId, { signal } = {}) {
      while (pending.length > 0) {
        yield makeJob(pending.shift());
      }
      await new Promise((resolve) => {
        const check = () => {
          if (!signal || signal.aborted) return resolve();
          setTimeout(check, 5);
        };
        check();
      });
    },
  };

  const worker = createHonkerWorker({
    name: "multi-stop-test",
    getQueue: () => queue,
    concurrency: 4,
    idlePollS: 1,
    processJob: async () => {
      workStarted.resolve();
      await gate;
    },
  });

  worker.start();
  await workStarted.promise;

  let settled = false;
  const stopPromise = worker.stop().then(() => {
    settled = true;
  });
  await delay(30);
  assert.equal(settled, false);
  release();
  await stopPromise;
  assert.equal(settled, true);
});
