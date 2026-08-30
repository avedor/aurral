import createHonkerWorker from "./honkerWorkerFactory.js";
import { getPipelineQueue } from "./honkerDb.js";
import {
  continuePipeline,
  processPipelinePayload,
  enqueuePendingJobsWithoutBatch,
  failPipelineJob,
} from "./slskdOrchestrator.js";
import { isAnyDownloadSourceConfigured } from "./downloadSourceService.js";
import { dbOps } from "../db/helpers/settings.js";

const DEFAULT_PIPELINE_CONCURRENCY = 4;
const PIPELINE_CONCURRENCY_MAX = 16;

function clampConcurrency(value) {
  return Math.max(
    1,
    Math.min(PIPELINE_CONCURRENCY_MAX, Math.floor(Number(value) || 1)),
  );
}

function resolvePipelineConcurrency() {
  const storedPipeline = dbOps.getJSONSetting("pipeline") || {};
  if (Number.isFinite(Number(storedPipeline.concurrency))) {
    return clampConcurrency(storedPipeline.concurrency);
  }
  const configured = Number(process.env.AURRAL_PIPELINE_CONCURRENCY);
  if (Number.isFinite(configured) && configured >= 1) {
    return clampConcurrency(configured);
  }
  return DEFAULT_PIPELINE_CONCURRENCY;
}

const {
  start: startSlskdOrchestratorWorker,
  stop: stopSlskdOrchestratorWorker,
  isRunning: isSlskdOrchestratorRunning,
} = createHonkerWorker({
  name: "slskd-pipeline",
  getQueue: getPipelineQueue,
  idlePollS: 2,
  retryDelayS: 30,
  concurrency: () => resolvePipelineConcurrency(),
  shouldRestart: () => isAnyDownloadSourceConfigured(),
  onStart() {
    if (!isAnyDownloadSourceConfigured()) return false;
    console.log("[pipeline] worker starting");
    enqueuePendingJobsWithoutBatch();
    return true;
  },
  processJob: async (payload) => {
    const nextPayload = await processPipelinePayload(payload);
    await continuePipeline(nextPayload);
  },
  onFinalFailure(job, error) {
    const message = error?.message || String(error);
    console.error("[slskdOrchestratorWorker] pipeline job failed:", {
      jobId: job.payload?.jobId || null,
      phase: job.payload?.phase || null,
      candidateIndex: job.payload?.candidateIndex ?? null,
      message,
      stack: error?.stack || null,
    });
    return failPipelineJob(job.payload, message);
  },
});

export {
  startSlskdOrchestratorWorker,
  stopSlskdOrchestratorWorker,
  isSlskdOrchestratorRunning,
  resolvePipelineConcurrency,
};
