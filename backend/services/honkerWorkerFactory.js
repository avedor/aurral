import {
  createIdleAbortController,
  getWorkerIdleStopMs,
  isHonkerShuttingDown,
  markHonkerWorkerLoopEnded,
  registerHonkerWorker,
  withJobHeartbeat,
} from "./honkerWorkerRuntime.js";
import { getWorkerId } from "./honkerDb.js";

export default function createHonkerWorker({
  name,
  getQueue,
  processJob,
  idlePollS,
  retryDelayS = 300,
  concurrency = 1,
  shouldRestart,
  onStart,
  filterJob,
  resolveRetry,
  onJobDequeue,
  onJobSuccess,
  onJobError,
  onFinalFailure,
  onLoopError,
}) {
  const loops = [];
  let running = false;
  let stopRequested = false;
  let stopResolve = null;
  let stopPromise = null;

  async function handleJobFailure(error, job, queue) {
    const message = error?.message || String(error);
    let attemptLimit = Number(queue.maxAttempts) || 3;
    try {
      const storedJob = queue.getJob(job.id);
      const storedLimit = Number(storedJob?.max_attempts);
      if (Number.isFinite(storedLimit) && storedLimit > 0) {
        attemptLimit = storedLimit;
      }
    } catch {}
    if (typeof onJobError === "function") {
      onJobError(error, job);
    }
    if (typeof resolveRetry === "function") {
      const decision = resolveRetry(error, job);
      if (decision?.action === "fail") {
        job.fail(decision.message ?? message);
        if (typeof onFinalFailure === "function") {
          await onFinalFailure(job, error);
        }
        return;
      }
      if (decision?.action === "retry") {
        job.retry(decision.delayS ?? retryDelayS, decision.message ?? message);
        return;
      }
    }
    if (job.attempts >= attemptLimit) {
      job.fail(message);
      if (typeof onFinalFailure === "function") {
        await onFinalFailure(job, error);
      }
    } else {
      job.retry(retryDelayS, message);
    }
  }

  function restartAllowed() {
    return typeof shouldRestart === "function" ? shouldRestart() : true;
  }

  function respawnLoop() {
    if (!running || stopRequested || isHonkerShuttingDown()) return;
    const timer = setTimeout(() => {
      if (!running || stopRequested || isHonkerShuttingDown()) return;
      spawnLoop();
    }, 1000);
    if (typeof timer.unref === "function") timer.unref();
  }

  function spawnLoop() {
    const queue = getQueue();
    const workerId = getWorkerId();
    const idleController = createIdleAbortController({
      idleStopMs: getWorkerIdleStopMs(),
    });
    idleController.arm();
    const loop = { idleController, alive: true, promise: null };
    loops.push(loop);
    loop.promise = runLoop(loop, queue, workerId, idleController);
    return loop;
  }

  async function runLoop(loop, queue, workerId, idleController) {
    try {
      for await (const job of queue.claim(workerId, {
        idlePollS,
        signal: idleController.signal,
      })) {
        idleController.disarm();
        if (stopRequested) break;
        if (typeof filterJob === "function" && filterJob(job) === false) {
          job.ack();
          idleController.arm();
          continue;
        }
        if (typeof onJobDequeue === "function") {
          onJobDequeue(job.payload, job);
        }
        try {
          await withJobHeartbeat(job, queue, () => processJob(job.payload, job));
          job.ack();
          if (typeof onJobSuccess === "function") {
            onJobSuccess(job.payload, job);
          }
        } catch (error) {
          await handleJobFailure(error, job, queue);
        }
        idleController.arm();
      }
    } catch (error) {
      if (typeof onLoopError === "function") {
        onLoopError(error);
      } else if (!idleController?.idleStopped && !stopRequested) {
        console.error(`[${name}] loop error:`, error);
      }
    } finally {
      idleController?.dispose();
      loop.alive = false;
      loop.idleController = null;
      loop.promise = null;
      const stillRunning = loops.some((candidate) => candidate.alive);
      const idleStopped = idleController?.idleStopped === true;
      const intentional = stopRequested || idleStopped;
      if (!stillRunning) {
        running = false;
        stopRequested = false;
        if (stopResolve) {
          const resolve = stopResolve;
          stopResolve = null;
          stopPromise = null;
          resolve();
        }
        markHonkerWorkerLoopEnded(name, restartAllowed() ? start : null, {
          intentional,
          ...(typeof shouldRestart === "function" ? { shouldRestart } : {}),
        });
      } else if (!intentional) {
        respawnLoop();
      }
    }
  }

  function start() {
    if (running || isHonkerShuttingDown()) return;
    if (typeof onStart === "function" && onStart() === false) return;
    running = true;
    stopRequested = false;
    const resolvedConcurrency =
      typeof concurrency === "function" ? concurrency() : concurrency;
    const concurrencyCount = Math.max(
      1,
      Math.floor(Number(resolvedConcurrency) || 1),
    );
    for (let index = 0; index < concurrencyCount; index += 1) {
      spawnLoop();
    }
  }

  function stop() {
    if (!running) return Promise.resolve();
    if (stopPromise) return stopPromise;
    stopRequested = true;
    for (const loop of loops) {
      loop.idleController?.abort();
    }
    stopPromise = new Promise((resolve) => {
      stopResolve = resolve;
    });
    return stopPromise;
  }

  function isRunning() {
    return running;
  }

  registerHonkerWorker(name, { start, stop, isRunning });
  return { start, stop, isRunning };
}
