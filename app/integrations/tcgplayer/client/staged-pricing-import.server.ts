import { sellerPortal } from "~/core/clients";

const PRICING_TYPE = "Pricing";
const FORM_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
};

const PATHS = {
  initialize: "/admin/pricing/initializeexportcsv",
  upload: "/admin/pricing/uploadexportcsv",
  finalize: "/admin/pricing/finalizeexportcsv",
  rollback: "/admin/pricing/rollbackexportcsv",
  moveToLive: "/admin/pricing/movetolive",
} as const;

export const STAGED_PRICING_IMPORT_CHUNK_SIZE = 750;

export interface StagedPricingUpdate {
  /** TCGplayer's ProductConditionId, used as the inventory SKU. */
  sku: number;
  /** Delta applied to live inventory when TCGplayer processes the update. */
  addToQuantity: number;
  price: number;
  rowId?: number;
}

export interface UploadStagedPricingChunkRequest {
  fileName: string;
  uploadId: number;
  updates: StagedPricingUpdate[];
}

export interface FinalizeStagedPricingImportRequest {
  uploadId: number;
  successfulProductCount: number;
}

export interface MoveStagedPricingImportRequest {
  uploadId: number;
  /** SignalR connection used only for optional progress reporting. */
  connectionId?: string;
}

export interface UploadStagedPricingChunkResponse {
  Success: boolean;
  Messages: unknown[];
  StagedPricingUploadId: number;
  SuccessfulProductCount: number;
}

export interface MoveStagedPricingImportItem {
  ProductConditionId: number;
  StorePriceCustomId: string | null;
  Message: string | null;
  ProductName: string;
  ChannelName: string;
}

export interface MoveStagedPricingImportResponse {
  Success: MoveStagedPricingImportItem[];
  Warning: MoveStagedPricingImportItem[];
  Error: MoveStagedPricingImportItem[];
  Update: MoveStagedPricingImportItem[];
}

export type SellerPortalFormPost = <TResponse>(
  path: string,
  form: URLSearchParams,
) => Promise<TResponse>;

// These stateful requests can carry signed quantity deltas. Never replay an
// ambiguous response automatically; callers must reconcile before retrying.
const postSellerPortalForm: SellerPortalFormPost = <TResponse>(
  path: string,
  form: URLSearchParams,
): Promise<TResponse> =>
  sellerPortal.post<TResponse, URLSearchParams>(path, form, {
    headers: FORM_HEADERS,
    retry: false,
  });

function requireNonEmptyText(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new RangeError(`${name} must not be empty.`);
  }
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function requireNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer.`);
  }
}

function requirePrice(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0.01 || value > 200_000) {
    throw new RangeError(
      `${name} must be a finite number between 0.01 and 200000.`,
    );
  }
}

function validateUpdate(update: StagedPricingUpdate, index: number): void {
  const prefix = `updates[${index}]`;
  requirePositiveInteger(update.sku, `${prefix}.sku`);

  if (!Number.isInteger(update.addToQuantity)) {
    throw new RangeError(`${prefix}.addToQuantity must be an integer.`);
  }

  requirePrice(update.price, `${prefix}.price`);

  if (update.rowId !== undefined) {
    requireNonNegativeInteger(update.rowId, `${prefix}.rowId`);
  }
}

export function buildInitializeStagedPricingImportForm(
  fileName: string,
): URLSearchParams {
  requireNonEmptyText(fileName, "fileName");
  return new URLSearchParams([
    ["filename", fileName],
    ["type", PRICING_TYPE],
  ]);
}

export function buildUploadStagedPricingChunkForm(
  request: UploadStagedPricingChunkRequest,
): URLSearchParams {
  requireNonEmptyText(request.fileName, "fileName");
  requirePositiveInteger(request.uploadId, "uploadId");
  if (request.updates.length === 0) {
    throw new RangeError("updates must contain at least one pricing update.");
  }
  if (request.updates.length > STAGED_PRICING_IMPORT_CHUNK_SIZE) {
    throw new RangeError(
      `updates must contain no more than ${STAGED_PRICING_IMPORT_CHUNK_SIZE} pricing updates.`,
    );
  }

  const form = new URLSearchParams();
  request.updates.forEach((update, index) => {
    validateUpdate(update, index);
    const prefix = `data[${index}]`;
    form.append(`${prefix}[Id]`, String(update.rowId ?? index));
    form.append(`${prefix}[ProductConditionId]`, String(update.sku));
    form.append(`${prefix}[AddToQuantity]`, String(update.addToQuantity));
    form.append(`${prefix}[MyPrice]`, update.price.toFixed(2));
  });
  form.append("stagedPricingUploadId", String(request.uploadId));
  form.append("fileName", request.fileName);
  form.append("type", PRICING_TYPE);
  return form;
}

export function buildFinalizeStagedPricingImportForm(
  request: FinalizeStagedPricingImportRequest,
): URLSearchParams {
  requirePositiveInteger(request.uploadId, "uploadId");
  requireNonNegativeInteger(
    request.successfulProductCount,
    "successfulProductCount",
  );
  return new URLSearchParams([
    ["stagedPricingUploadId", String(request.uploadId)],
    ["productCount", String(request.successfulProductCount)],
    ["type", PRICING_TYPE],
  ]);
}

export function buildRollbackStagedPricingImportForm(
  uploadId: number,
): URLSearchParams {
  requirePositiveInteger(uploadId, "uploadId");
  return new URLSearchParams([
    ["stagedPricingUploadId", String(uploadId)],
    ["type", PRICING_TYPE],
  ]);
}

export function buildMoveStagedPricingImportToLiveForm(
  request: MoveStagedPricingImportRequest,
): URLSearchParams {
  requirePositiveInteger(request.uploadId, "uploadId");
  return new URLSearchParams([
    ["scope", "3"],
    ["connectionId", request.connectionId ?? ""],
    ["stagedPricingUploadId", String(request.uploadId)],
    ["type", PRICING_TYPE],
  ]);
}

export async function initializeStagedPricingImport(
  fileName: string,
  post: SellerPortalFormPost = postSellerPortalForm,
): Promise<number> {
  const response = await post<{ StagedPricingUploadId: number }>(
    PATHS.initialize,
    buildInitializeStagedPricingImportForm(fileName),
  );
  requirePositiveInteger(
    response.StagedPricingUploadId,
    "StagedPricingUploadId",
  );
  return response.StagedPricingUploadId;
}

export async function uploadStagedPricingChunk(
  request: UploadStagedPricingChunkRequest,
  post: SellerPortalFormPost = postSellerPortalForm,
): Promise<UploadStagedPricingChunkResponse> {
  const response = await post<UploadStagedPricingChunkResponse>(
    PATHS.upload,
    buildUploadStagedPricingChunkForm(request),
  );
  if (!response.Success) {
    throw new Error(
      `TCGplayer did not accept staged pricing upload ${request.uploadId}.`,
    );
  }
  return response;
}

export async function finalizeStagedPricingImport(
  request: FinalizeStagedPricingImportRequest,
  post: SellerPortalFormPost = postSellerPortalForm,
): Promise<void> {
  const response = await post<{ success: boolean }>(
    PATHS.finalize,
    buildFinalizeStagedPricingImportForm(request),
  );
  if (!response.success) {
    throw new Error(
      `TCGplayer did not finalize staged pricing upload ${request.uploadId}.`,
    );
  }
}

export async function rollbackStagedPricingImport(
  uploadId: number,
  post: SellerPortalFormPost = postSellerPortalForm,
): Promise<void> {
  await post<unknown>(
    PATHS.rollback,
    buildRollbackStagedPricingImportForm(uploadId),
  );
}

export async function moveStagedPricingImportToLive(
  request: MoveStagedPricingImportRequest,
  post: SellerPortalFormPost = postSellerPortalForm,
): Promise<MoveStagedPricingImportResponse> {
  return post<MoveStagedPricingImportResponse>(
    PATHS.moveToLive,
    buildMoveStagedPricingImportToLiveForm(request),
  );
}
