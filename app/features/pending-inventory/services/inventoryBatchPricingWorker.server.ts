import { inventoryBatchPricingJobsRepository, inventoryBatchesRepository } from "~/core/db";
import { PricedSkuToTcgPlayerListingConverter } from "~/features/file-upload/services/dataConverters";
import type { ProcessingProgress, PricedSku } from "~/core/types/pricing";
import type { InventoryBatchPricingJob } from "../types/inventoryBatch";
import { executeInventoryBatchPricingJob } from "./inventoryBatchPricing.server";

const LEASE_MS = 15_000;
const HEARTBEAT_MS = 2_000;
const POLL_MS = 1_000;
const PROGRESS_FLUSH_MS = 1_000;

interface WorkerState {
  started: boolean;
  running: boolean;
  timer: NodeJS.Timeout | null;
  workerId: string;
}

declare global {
  var __inventoryBatchPricingWorkerState: WorkerState | undefined;
}

const converter = new PricedSkuToTcgPlayerListingConverter();

function getWorkerState(): WorkerState {
  if (!globalThis.__inventoryBatchPricingWorkerState) {
    globalThis.__inventoryBatchPricingWorkerState = {
      started: false,
      running: false,
      timer: null,
      workerId: `inventory-batch-worker-${process.pid}`,
    };
  }

  return globalThis.__inventoryBatchPricingWorkerState;
}

function scheduleNextTick(state: WorkerState, delayMs: number): void {
  if (state.timer) {
    clearTimeout(state.timer);
  }

  state.timer = setTimeout(() => {
    void tick(state);
  }, delayMs);
}

function getPricedSkuResultStatus(pricedSku: PricedSku): "successful" | "manual_review" {
  const hasErrors = Boolean(pricedSku.errors && pricedSku.errors.length > 0);
  const hasPrice =
    pricedSku.price !== undefined &&
    pricedSku.price !== null &&
    pricedSku.price > 0;

  return hasPrice && !hasErrors ? "successful" : "manual_review";
}

async function processJob(
  state: WorkerState,
  job: InventoryBatchPricingJob,
): Promise<void> {
  let latestProgress: ProcessingProgress | null = job.progress;
  let lastProgressFlush = 0;

  const flushProgress = async (): Promise<void> => {
    await inventoryBatchPricingJobsRepository.heartbeat(
      job.id,
      state.workerId,
      LEASE_MS,
      latestProgress,
    );
  };

  const heartbeat = setInterval(() => {
    void flushProgress();
  }, HEARTBEAT_MS);

  try {
    const result = await executeInventoryBatchPricingJob({
      batchNumber: job.batchNumber,
      mode: job.mode,
      config: job.config,
      onProgress: (progress) => {
        latestProgress = progress;
        const now = Date.now();
        if (now - lastProgressFlush >= PROGRESS_FLUSH_MS) {
          lastProgressFlush = now;
          void flushProgress();
        }
      },
    });

    const rows = converter.convertFromPricedSkus(result.pricedSkus);

    await inventoryBatchesRepository.saveResults({
      batchNumber: job.batchNumber,
      mode: job.mode,
      summary: result.summary,
      rows: result.pricedSkus.map((pricedSku, index) => ({
        sku: pricedSku.sku,
        resultStatus: getPricedSkuResultStatus(pricedSku),
        row: rows[index],
        errorMessages: pricedSku.errors || [],
        warningMessages: pricedSku.warnings || [],
        pricedAt: new Date(),
      })),
    });

    latestProgress = result.finalProgress;
    await inventoryBatchPricingJobsRepository.complete(
      job.id,
      result.summary,
      result.finalProgress,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await inventoryBatchPricingJobsRepository.fail(
      job.id,
      job.batchNumber,
      message,
      latestProgress,
    );
  } finally {
    clearInterval(heartbeat);
  }
}

async function tick(state: WorkerState): Promise<void> {
  if (state.running) {
    return;
  }

  state.running = true;

  try {
    await inventoryBatchPricingJobsRepository.requeueExpiredJobs();
    const job = await inventoryBatchPricingJobsRepository.claimNextQueuedJob(
      state.workerId,
      LEASE_MS,
    );

    if (!job) {
      scheduleNextTick(state, POLL_MS);
      return;
    }

    await processJob(state, job);
    scheduleNextTick(state, 0);
  } catch (error) {
    console.error("Inventory batch pricing worker failed:", error);
    scheduleNextTick(state, POLL_MS);
  } finally {
    state.running = false;
  }
}

export function ensureInventoryBatchPricingWorker(): void {
  const state = getWorkerState();

  if (state.started) {
    return;
  }

  state.started = true;
  scheduleNextTick(state, 0);
}
