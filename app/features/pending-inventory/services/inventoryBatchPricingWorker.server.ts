import { profitPerDayPolicy } from "~/features/pricing/types/config";
import {
  continuousPricingRepository,
  inventoryBatchPricingJobsRepository,
  inventoryBatchesRepository,
  inventoryStrategyRepository,
} from "~/core/db";
import { PricedSkuToTcgPlayerListingConverter } from "~/features/file-upload/services/dataConverters";
import { planAutomaticInventoryBatchPublication } from "~/features/inventory-publication/services/automaticInventoryBatchPublication.server";
import type {
  PersistedPricingDetails,
  ProcessingProgress,
  PricedSku,
} from "~/core/types/pricing";
import { PRICING_MODEL_VERSION } from "~/core/types/pricingPolicy";
import type { InventoryBatchPricingJob } from "../types/inventoryBatch";
import { executeInventoryBatchPricingJob } from "./inventoryBatchPricing.server";

const LEASE_MS = 15_000;
const HEARTBEAT_MS = 2_000;
const POLL_MS = 1_000;
const PROGRESS_FLUSH_MS = 1_000;
const PRICING_DETAILS_SCHEMA_VERSION = 2;

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

function getPricedSkuResultStatus(
  pricedSku: PricedSku,
): "successful" | "manual_review" {
  const hasErrors = Boolean(pricedSku.errors && pricedSku.errors.length > 0);
  const hasPrice =
    pricedSku.price !== undefined &&
    pricedSku.price !== null &&
    pricedSku.price > 0;

  return hasPrice && !hasErrors ? "successful" : "manual_review";
}

function buildPricingDetails(
  pricedSku: PricedSku,
  mode: InventoryBatchPricingJob["mode"],
  pricedAt: Date,
  job: InventoryBatchPricingJob,
): PersistedPricingDetails {
  return {
    schemaVersion: PRICING_DETAILS_SCHEMA_VERSION,
    pricingModelVersion: PRICING_MODEL_VERSION,
    mode,
    pricedAt: pricedAt.toISOString(),
    marketDataAt: pricedSku.marketDataAt ?? pricedAt.toISOString(),
    productLineId: pricedSku.productLineId,
    percentileUsed: pricedSku.percentileUsed,
    suggestedPrice: pricedSku.suggestedPrice,
    marketplacePrice: pricedSku.price,
    previousPrice: pricedSku.previousPrice,
    tcgMarketPrice: pricedSku.tcgMarketPrice,
    lowestSalePrice: pricedSku.lowestSalePrice,
    highestSalePrice: pricedSku.highestSalePrice,
    quantity: pricedSku.quantity,
    addToQuantity: pricedSku.addToQuantity,
    historicalSalesVelocityDays: pricedSku.historicalSalesVelocityDays,
    estimatedTimeToSellDays: pricedSku.estimatedTimeToSellDays,
    salesCountForHistorical: pricedSku.salesCountForHistorical,
    listingsCountForEstimated: pricedSku.listingsCountForEstimated,
    percentiles: pricedSku.percentiles,
    buyerChoiceForecast: pricedSku.buyerChoiceForecast,
    conditionRateForecast: pricedSku.conditionRateForecast,
    conditionNormalization: pricedSku.conditionNormalization,
    priceEvidence: pricedSku.priceEvidence,
    warnings: pricedSku.warnings || [],
    errors: pricedSku.errors || [],
    featureFlags: {
      supplyAnalysis: job.config.supplyAnalysis.enableSupplyAnalysis,
    },
    policy:
      pricedSku.pricingDecision?.method === "target-horizon" &&
      pricedSku.pricingDecision.targetHorizonDays !== undefined
        ? {
            method: "target-horizon",
            horizonDays: pricedSku.pricingDecision.targetHorizonDays,
          }
        : pricedSku.pricingDecision?.method === "profit-per-day" &&
            pricedSku.pricingDecision.dailyReturnHurdle !== undefined
          ? {
              ...profitPerDayPolicy(job.config.pricing.profitPerDay),
              dailyReturnHurdle: pricedSku.pricingDecision.dailyReturnHurdle,
            }
          : pricedSku.pricingDecision?.method === "percentile"
            ? {
                method: "percentile",
                percentile:
                  pricedSku.pricingDecision.configuredPercentile ??
                  pricedSku.percentileUsed ??
                  job.config.productLinePricing.defaultPercentile,
              }
            : undefined,
    decision: pricedSku.pricingDecision,
    shadowDecision: pricedSku.shadowPricingDecision,
  };
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
    const pricedAt = new Date();

    await inventoryBatchesRepository.saveResults({
      batchNumber: job.batchNumber,
      mode: job.mode,
      rows: result.pricedSkus.map((pricedSku, index) => ({
        sku: pricedSku.sku,
        resultStatus: getPricedSkuResultStatus(pricedSku),
        row: rows[index],
        pricingDetails: buildPricingDetails(pricedSku, job.mode, pricedAt, job),
        errorMessages: pricedSku.errors || [],
        warningMessages: pricedSku.warnings || [],
        pricedAt,
      })),
    });

    latestProgress = result.finalProgress;
    await inventoryBatchPricingJobsRepository.complete(
      job.id,
      result.summary,
      result.finalProgress,
    );
    try {
      await inventoryStrategyRepository.recordSuccessfulBatch(job.batchNumber);
    } catch (strategyProjectionError) {
      console.error(
        `Inventory strategy projection update failed for batch ${job.batchNumber}:`,
        strategyProjectionError,
      );
    }
    try {
      await continuousPricingRepository.recordBatchCompleted(job.batchNumber);
    } catch (projectionError) {
      console.error(
        `Continuous pricing projection update failed for batch ${job.batchNumber}:`,
        projectionError,
      );
    }

    try {
      await planAutomaticInventoryBatchPublication(job.batchNumber);
    } catch (automaticPublicationError) {
      console.error(
        `Automatic publication planning failed for batch ${job.batchNumber}:`,
        automaticPublicationError,
      );
    }
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

export function startInventoryBatchPricingWorkerProcess(): void {
  const state = getWorkerState();
  if (state.started) {
    return;
  }
  state.started = true;
  scheduleNextTick(state, 0);
}

export function ensureInventoryBatchPricingWorker(): void {
  if (process.env.WORKERS_RUN_IN_PROCESS === "false") {
    return;
  }
  startInventoryBatchPricingWorkerProcess();
}
