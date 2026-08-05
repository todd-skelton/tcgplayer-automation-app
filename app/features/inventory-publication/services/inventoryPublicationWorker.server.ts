import {
  continuousPricingRepository,
  inventoryPublicationSettingsRepository,
  inventoryPublicationsRepository,
} from "~/core/db";
import {
  finalizeStagedPricingImport,
  initializeStagedPricingImport,
  moveStagedPricingImportToLive,
  rollbackStagedPricingImport,
  STAGED_PRICING_IMPORT_CHUNK_SIZE,
  type MoveStagedPricingImportResponse,
  type StagedPricingUpdate,
  uploadStagedPricingChunk,
} from "~/integrations/tcgplayer/client/staged-pricing-import.server";
import type {
  InventoryPublication,
  InventoryPublicationItem,
  InventoryPublicationItemOutcome,
  InventoryPublicationStatus,
} from "../types/inventoryPublication";

const LEASE_MS = 30_000;
const HEARTBEAT_MS = 5_000;
const POLL_MS = 1_000;

interface WorkerState {
  started: boolean;
  running: boolean;
  timer: NodeJS.Timeout | null;
  workerId: string;
}

declare global {
  var __inventoryPublicationWorkerState: WorkerState | undefined;
}

export interface InventoryPublicationWorkerDependencies {
  initialize(fileName: string): Promise<number>;
  upload(request: {
    fileName: string;
    uploadId: number;
    updates: StagedPricingUpdate[];
  }): Promise<{ SuccessfulProductCount: number; Messages?: unknown[] }>;
  finalize(request: {
    uploadId: number;
    successfulProductCount: number;
  }): Promise<void>;
  rollback(uploadId: number): Promise<void>;
  move(request: { uploadId: number }): Promise<MoveStagedPricingImportResponse>;
  recordUploadId(
    publicationId: number,
    workerId: string,
    uploadId: number,
  ): Promise<void>;
  transition(
    publicationId: number,
    expectedStatus: InventoryPublicationStatus,
    nextStatus: InventoryPublicationStatus,
    options?: {
      workerId?: string;
      errorCode?: string | null;
      errorMessage?: string | null;
    },
  ): Promise<InventoryPublication>;
  saveItemOutcomes(
    publicationId: number,
    outcomes: InventoryPublicationItemOutcome[],
  ): Promise<void>;
  markPlannedItems(
    publicationId: number,
    status: "ambiguous" | "failed",
    errorCode: string,
    errorMessage: string,
  ): Promise<number>;
  recordPortalSuccess?(): Promise<void>;
  recordPortalFailure?(error: unknown): Promise<void>;
  recordPublishedPrices?(
    publication: InventoryPublication,
    outcomes: InventoryPublicationItemOutcome[],
  ): Promise<void>;
}

const defaultDependencies: InventoryPublicationWorkerDependencies = {
  initialize: initializeStagedPricingImport,
  upload: uploadStagedPricingChunk,
  finalize: finalizeStagedPricingImport,
  rollback: rollbackStagedPricingImport,
  move: moveStagedPricingImportToLive,
  recordUploadId: (publicationId, workerId, uploadId) =>
    inventoryPublicationsRepository.recordStagedUploadId(
      publicationId,
      workerId,
      uploadId,
    ),
  transition: (publicationId, expectedStatus, nextStatus, options) =>
    inventoryPublicationsRepository.transitionStatus(
      publicationId,
      expectedStatus,
      nextStatus,
      options,
    ),
  saveItemOutcomes: (publicationId, outcomes) =>
    inventoryPublicationsRepository.saveItemOutcomes(publicationId, outcomes),
  markPlannedItems: (publicationId, status, errorCode, errorMessage) =>
    inventoryPublicationsRepository.markPlannedItems(
      publicationId,
      status,
      errorCode,
      errorMessage,
    ),
  recordPortalSuccess: async () => {
    await inventoryPublicationSettingsRepository.recordSuccess();
  },
  recordPortalFailure: async (error) => {
    const configuration = await inventoryPublicationSettingsRepository.get();
    await inventoryPublicationSettingsRepository.recordFailure({
      authenticationFailure: isSellerPortalAuthenticationFailure(error),
      message: getErrorMessage(error),
      consecutiveFailureLimit: configuration.settings.consecutiveFailureLimit,
    });
  },
  recordPublishedPrices: async (publication, outcomes) => {
    if (publication.sourceType !== "continuous" || !publication.sellerKey) {
      return;
    }
    const publishedIds = new Set(
      outcomes
        .filter((outcome) => outcome.status === "published")
        .map((outcome) => outcome.itemId),
    );
    await continuousPricingRepository.recordPublishedPrices(
      publication.sellerKey,
      publication.items
        .filter((item) => publishedIds.has(item.id))
        .map((item) => ({ sku: item.sku, price: item.desiredPrice })),
    );
    const ambiguousIds = new Set(
      outcomes
        .filter((outcome) => outcome.status === "ambiguous")
        .map((outcome) => outcome.itemId),
    );
    await continuousPricingRepository.pauseAmbiguousSkus(
      publication.sellerKey,
      publication.items
        .filter((item) => ambiguousIds.has(item.id))
        .map((item) => item.sku),
    );
  },
};

function getWorkerState(): WorkerState {
  if (!globalThis.__inventoryPublicationWorkerState) {
    globalThis.__inventoryPublicationWorkerState = {
      started: false,
      running: false,
      timer: null,
      workerId: `inventory-publication-worker-${process.pid}`,
    };
  }
  return globalThis.__inventoryPublicationWorkerState;
}

function scheduleNextTick(state: WorkerState, delayMs: number): void {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = setTimeout(() => {
    void tick(state);
  }, delayMs);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSellerPortalMessages(messages?: unknown[]): string {
  if (!messages?.length) {
    return "";
  }

  const formatted = messages
    .map((message) =>
      typeof message === "string" ? message : JSON.stringify(message),
    )
    .filter((message): message is string => Boolean(message))
    .join("; ");
  return formatted ? `Seller Portal messages: ${formatted.slice(0, 1000)}` : "";
}

export function isSellerPortalAuthenticationFailure(error: unknown): boolean {
  const candidate = error as { response?: { status?: unknown } };
  const status = Number(candidate?.response?.status);
  if (status === 401 || status === 403) {
    return true;
  }

  const message = getErrorMessage(error).toLowerCase();
  return [
    "unauthorized",
    "forbidden",
    "sign in",
    "signin",
    "log in",
    "login",
    "authentication",
    "auth cookie",
  ].some((indicator) => message.includes(indicator));
}

async function safelyRecordPortalSuccess(
  dependencies: InventoryPublicationWorkerDependencies,
): Promise<void> {
  try {
    await dependencies.recordPortalSuccess?.();
  } catch (error) {
    console.error("Could not record Seller Portal success health:", error);
  }
}

async function safelyRecordPortalFailure(
  dependencies: InventoryPublicationWorkerDependencies,
  error: unknown,
): Promise<void> {
  try {
    await dependencies.recordPortalFailure?.(error);
  } catch (healthError) {
    console.error(
      "Could not record Seller Portal failure health:",
      healthError,
    );
  }
}
async function safelyRecordPublicationProjection(
  dependencies: InventoryPublicationWorkerDependencies,
  publication: InventoryPublication,
  outcomes: InventoryPublicationItemOutcome[],
): Promise<void> {
  try {
    await dependencies.recordPublishedPrices?.(publication, outcomes);
  } catch (error) {
    console.error("Could not record continuous publication projection:", error);
  }
}
function toStagedPricingUpdate(
  item: InventoryPublicationItem,
): StagedPricingUpdate {
  return {
    sku: item.sku,
    productLine: item.productLine,
    setName: item.setName,
    productName: item.productName,
    condition: item.condition,
    addToQuantity: item.quantityDelta,
    price: item.desiredPrice,
  };
}

function chunkUpdates(updates: StagedPricingUpdate[]): StagedPricingUpdate[][] {
  const chunks: StagedPricingUpdate[][] = [];
  for (
    let index = 0;
    index < updates.length;
    index += STAGED_PRICING_IMPORT_CHUNK_SIZE
  ) {
    chunks.push(updates.slice(index, index + STAGED_PRICING_IMPORT_CHUNK_SIZE));
  }
  return chunks;
}

function responseItemsBySku(
  items: MoveStagedPricingImportResponse[keyof MoveStagedPricingImportResponse],
): Map<number, string | null> {
  return new Map(
    items.map((item) => [item.ProductConditionId, item.Message ?? null]),
  );
}

export function buildMoveToLiveOutcomes(
  items: InventoryPublicationItem[],
  response: MoveStagedPricingImportResponse,
): InventoryPublicationItemOutcome[] {
  const confirmed = responseItemsBySku([
    ...response.Success,
    ...response.Update,
  ]);
  const warnings = responseItemsBySku(response.Warning);
  const errors = responseItemsBySku(response.Error);

  return items.map((item) => {
    if (errors.has(item.sku)) {
      return {
        itemId: item.id,
        status: "failed",
        errorCode: "seller_portal_item_error",
        errorMessage:
          errors.get(item.sku) ??
          "TCGplayer rejected this item while moving pricing live.",
      };
    }
    if (warnings.has(item.sku)) {
      return {
        itemId: item.id,
        status: "ambiguous",
        errorCode: "seller_portal_item_warning",
        errorMessage:
          warnings.get(item.sku) ??
          "TCGplayer returned a warning without a confirmed item outcome.",
      };
    }
    if (confirmed.has(item.sku)) {
      return {
        itemId: item.id,
        status: "published",
      };
    }
    return {
      itemId: item.id,
      status: "ambiguous",
      errorCode: "seller_portal_item_missing",
      errorMessage:
        "TCGplayer did not return a move-to-live outcome for this item.",
    };
  });
}

async function failBeforeMove(
  publication: InventoryPublication,
  workerId: string,
  currentStatus: "staging" | "staged",
  uploadId: number | null,
  error: unknown,
  dependencies: InventoryPublicationWorkerDependencies,
  recordPortalFailure = true,
): Promise<void> {
  const originalMessage = getErrorMessage(error);
  if (recordPortalFailure) {
    await safelyRecordPortalFailure(dependencies, error);
  }

  if (uploadId !== null) {
    try {
      await dependencies.rollback(uploadId);
      await dependencies.markPlannedItems(
        publication.id,
        "failed",
        "staged_publication_rolled_back",
        originalMessage,
      );
      await dependencies.transition(
        publication.id,
        currentStatus,
        "rolled_back",
        {
          workerId,
          errorCode: "staged_publication_rolled_back",
          errorMessage: originalMessage,
        },
      );
      return;
    } catch (rollbackError) {
      const rollbackMessage = getErrorMessage(rollbackError);
      const ambiguousMessage = `${originalMessage} Rollback also failed: ${rollbackMessage}`;
      await dependencies.markPlannedItems(
        publication.id,
        "ambiguous",
        "staged_rollback_ambiguous",
        ambiguousMessage,
      );
      await dependencies.transition(
        publication.id,
        currentStatus,
        "ambiguous",
        {
          workerId,
          errorCode: "staged_rollback_ambiguous",
          errorMessage: ambiguousMessage,
        },
      );
      return;
    }
  }

  await dependencies.markPlannedItems(
    publication.id,
    "failed",
    "staged_initialization_failed",
    originalMessage,
  );
  await dependencies.transition(publication.id, currentStatus, "failed", {
    workerId,
    errorCode: "staged_initialization_failed",
    errorMessage: originalMessage,
  });
}

export async function executeClaimedStagedPublication(
  publication: InventoryPublication,
  workerId: string,
  dependencies: InventoryPublicationWorkerDependencies = defaultDependencies,
): Promise<void> {
  if (publication.method !== "staged_delta") {
    throw new Error(
      `Publication ${publication.id} does not use staged delta publishing.`,
    );
  }
  if (publication.status !== "staging") {
    throw new Error(
      `Publication ${publication.id} must be staging before execution.`,
    );
  }

  const plannedItems = publication.items.filter(
    (item) => item.status === "planned",
  );
  if (plannedItems.length === 0) {
    await failBeforeMove(
      publication,
      workerId,
      "staging",
      null,
      new Error("Publication has no planned items."),
      dependencies,
      false,
    );
    return;
  }

  const fileName = `inventory-publication-${publication.id}.csv`;
  const updates = plannedItems.map(toStagedPricingUpdate);
  let uploadId: number | null = null;
  let currentStatus: "staging" | "staged" = "staging";

  try {
    uploadId = await dependencies.initialize(fileName);
    await dependencies.recordUploadId(publication.id, workerId, uploadId);

    for (const chunk of chunkUpdates(updates)) {
      const result = await dependencies.upload({
        fileName,
        uploadId,
        updates: chunk,
      });
      if (result.SuccessfulProductCount !== chunk.length) {
        throw new Error(
          [
            `TCGplayer accepted ${result.SuccessfulProductCount} of ${chunk.length} staged pricing rows.`,
            formatSellerPortalMessages(result.Messages),
          ]
            .filter(Boolean)
            .join(" "),
        );
      }
    }

    await dependencies.finalize({
      uploadId,
      successfulProductCount: updates.length,
    });
    await dependencies.transition(publication.id, "staging", "staged", {
      workerId,
    });
    currentStatus = "staged";
  } catch (error) {
    await failBeforeMove(
      publication,
      workerId,
      currentStatus,
      uploadId,
      error,
      dependencies,
    );
    return;
  }

  await dependencies.transition(publication.id, "staged", "publishing", {
    workerId,
  });

  try {
    const response = await dependencies.move({ uploadId });
    const outcomes = buildMoveToLiveOutcomes(plannedItems, response);
    await dependencies.saveItemOutcomes(publication.id, outcomes);

    const hasAmbiguousItems = outcomes.some(
      (outcome) => outcome.status === "ambiguous",
    );
    await dependencies.transition(
      publication.id,
      "publishing",
      hasAmbiguousItems ? "ambiguous" : "published",
      {
        workerId,
        errorCode: hasAmbiguousItems
          ? "seller_portal_item_outcome_ambiguous"
          : null,
        errorMessage: hasAmbiguousItems
          ? "One or more Seller Portal item outcomes require reconciliation."
          : null,
      },
    );
    await safelyRecordPortalSuccess(dependencies);
    await safelyRecordPublicationProjection(
      dependencies,
      publication,
      outcomes,
    );
  } catch (error) {
    const message = getErrorMessage(error);
    await safelyRecordPortalFailure(dependencies, error);
    await dependencies.markPlannedItems(
      publication.id,
      "ambiguous",
      "move_to_live_ambiguous",
      message,
    );
    await dependencies.transition(publication.id, "publishing", "ambiguous", {
      workerId,
      errorCode: "move_to_live_ambiguous",
      errorMessage: message,
    });
  }
}

async function processClaimedPublication(
  state: WorkerState,
  publication: InventoryPublication,
): Promise<void> {
  const heartbeat = setInterval(() => {
    void inventoryPublicationsRepository.heartbeat(
      publication.id,
      state.workerId,
      LEASE_MS,
    );
  }, HEARTBEAT_MS);

  try {
    if (publication.method === "staged_delta") {
      await executeClaimedStagedPublication(publication, state.workerId);
      return;
    }

    await inventoryPublicationsRepository.markPlannedItems(
      publication.id,
      "failed",
      "unsupported_publication_method",
      "The direct absolute publication worker is not implemented.",
    );
    await inventoryPublicationsRepository.transitionStatus(
      publication.id,
      "publishing",
      "failed",
      {
        workerId: state.workerId,
        errorCode: "unsupported_publication_method",
        errorMessage:
          "The direct absolute publication worker is not implemented.",
      },
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
    await inventoryPublicationsRepository.recoverExpiredClaims();
    const configuration = await inventoryPublicationSettingsRepository.get();
    if (
      configuration.settings.globalPaused ||
      configuration.runtime.circuitOpen ||
      configuration.runtime.authenticationStatus === "invalid"
    ) {
      scheduleNextTick(state, POLL_MS);
      return;
    }

    const publication = await inventoryPublicationsRepository.claimNextPlanned(
      state.workerId,
      LEASE_MS,
    );

    if (!publication) {
      scheduleNextTick(state, POLL_MS);
      return;
    }

    await processClaimedPublication(state, publication);
    scheduleNextTick(state, 0);
  } catch (error) {
    console.error("Inventory publication worker failed:", error);
    scheduleNextTick(state, POLL_MS);
  } finally {
    state.running = false;
  }
}

export function startInventoryPublicationWorkerProcess(): void {
  const state = getWorkerState();
  if (state.started) {
    return;
  }
  state.started = true;
  scheduleNextTick(state, 0);
}

export function ensureInventoryPublicationWorker(): void {
  if (process.env.WORKERS_RUN_IN_PROCESS === "false") {
    return;
  }
  startInventoryPublicationWorkerProcess();
}
