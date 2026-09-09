import { sellerPortal } from "~/core/clients";
import type { SafeHttpResponseMetadata } from "~/core/clients/baseDomainClient.server";

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
  observeResponse?: (metadata: SafeHttpResponseMetadata) => void,
) => Promise<TResponse>;

// These stateful requests can carry signed quantity deltas. Never replay an
// ambiguous response automatically; callers must reconcile before retrying.
const postSellerPortalForm: SellerPortalFormPost = <TResponse>(
  path: string,
  form: URLSearchParams,
  observeResponse?: (metadata: SafeHttpResponseMetadata) => void,
): Promise<TResponse> =>
  sellerPortal.post<TResponse, URLSearchParams>(path, form, {
    headers: FORM_HEADERS,
    retry: false,
    observeResponse,
  });

export type StagedPricingInitializationErrorCode =
  | "staged_initialization_authentication_required"
  | "staged_initialization_challenge"
  | "staged_initialization_rejected"
  | "staged_initialization_response_invalid"
  | "staged_initialization_transport_failed";

export class StagedPricingInitializationError extends Error {
  readonly name = "StagedPricingInitializationError";

  constructor(
    readonly code: StagedPricingInitializationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function getStagedPricingInitializationErrorCode(
  error: unknown,
): StagedPricingInitializationErrorCode | null {
  return error instanceof StagedPricingInitializationError ? error.code : null;
}

function valueKind(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function responseKind(value: unknown): string {
  if (typeof value === "string" && /<html\b|<!doctype\s+html/i.test(value)) {
    return "html";
  }
  return valueKind(value);
}

function knownFieldShape(response: unknown): string {
  if (response === null || Array.isArray(response) || typeof response !== "object") {
    return "none";
  }
  const record = response as Record<string, unknown>;
  const fields = [
    "StagedPricingUploadId",
    "Success",
    "success",
    "Error",
    "Errors",
    "error",
    "errors",
    "Message",
    "Messages",
  ].flatMap((name) =>
    Object.hasOwn(record, name) ? [`${name}:${valueKind(record[name])}`] : [],
  );
  return fields.length > 0 ? fields.join(",") : "none";
}

function metadataShape(metadata: SafeHttpResponseMetadata | null): string {
  if (!metadata) return "status=unknown; contentType=unknown; redirected=unknown";
  return [
    `status=${metadata.status}`,
    `contentType=${metadata.contentType ?? "unknown"}`,
    `redirected=${metadata.redirected === null ? "unknown" : String(metadata.redirected)}`,
  ].join("; ");
}

function responseDiagnostics(
  response: unknown,
  metadata: SafeHttpResponseMetadata | null,
): string {
  return `${metadataShape(metadata)}; response=${responseKind(response)}; fields=${knownFieldShape(response)}`;
}

function hasExplicitProviderError(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && typeof value === "object" && Object.keys(value).length > 0;
}

function isExplicitProviderRejection(response: unknown): boolean {
  if (response === null || Array.isArray(response) || typeof response !== "object") {
    return false;
  }
  const record = response as Record<string, unknown>;
  if (record.Success === false || record.success === false) return true;
  return ["Error", "Errors", "error", "errors"].some(
    (name) => Object.hasOwn(record, name) && hasExplicitProviderError(record[name]),
  );
}

function isLoginResponse(
  response: unknown,
  metadata: SafeHttpResponseMetadata | null,
): boolean {
  if (metadata?.status === 401 || metadata?.status === 403) return true;
  if (typeof response !== "string" || responseKind(response) !== "html") return false;
  return /<form\b[^>]*(login|sign.?in)|\b(login|sign in|authentication)\b/i.test(
    response,
  );
}

function isChallengeResponse(response: unknown): boolean {
  return (
    typeof response === "string" &&
    responseKind(response) === "html" &&
    /captcha|cf-chl-|challenge-platform|verify you are human|access denied/i.test(
      response,
    )
  );
}

const SAFE_TRANSPORT_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ERR_CANCELED",
  "ERR_NETWORK",
]);

function getTransportStatus(error: unknown): number | null {
  const status = (error as { response?: { status?: unknown } } | null)?.response
    ?.status;
  return typeof status === "number" && Number.isInteger(status)
    ? status
    : null;
}

function getTransportCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SAFE_TRANSPORT_CODES.has(code)
    ? code
    : "other";
}

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
  let metadata: SafeHttpResponseMetadata | null = null;
  let response: unknown;
  try {
    response = await post<unknown>(
      PATHS.initialize,
      buildInitializeStagedPricingImportForm(fileName),
      (observedMetadata) => {
        metadata = observedMetadata;
      },
    );
  } catch (error) {
    const status = getTransportStatus(error);
    const code = getTransportCode(error);
    if (status === 401 || status === 403) {
      throw new StagedPricingInitializationError(
        "staged_initialization_authentication_required",
        `Seller Portal required authentication for staged pricing initialization (status=${status}; transport=${code}).`,
      );
    }
    throw new StagedPricingInitializationError(
      "staged_initialization_transport_failed",
      `Seller Portal staged pricing initialization failed before a response was confirmed (status=${status ?? "unknown"}; transport=${code}).`,
    );
  }
  const diagnostics = responseDiagnostics(response, metadata);

  if (isChallengeResponse(response)) {
    throw new StagedPricingInitializationError(
      "staged_initialization_challenge",
      `Seller Portal challenged the staged pricing initialization request (${diagnostics}).`,
    );
  }
  if (isLoginResponse(response, metadata)) {
    throw new StagedPricingInitializationError(
      "staged_initialization_authentication_required",
      `Seller Portal required authentication for staged pricing initialization (${diagnostics}).`,
    );
  }
  if (isExplicitProviderRejection(response)) {
    throw new StagedPricingInitializationError(
      "staged_initialization_rejected",
      `Seller Portal rejected staged pricing initialization (${diagnostics}).`,
    );
  }

  const uploadId =
    response !== null && !Array.isArray(response) && typeof response === "object"
      ? (response as Record<string, unknown>).StagedPricingUploadId
      : undefined;
  if (
    typeof uploadId !== "number" ||
    !Number.isSafeInteger(uploadId) ||
    uploadId <= 0
  ) {
    throw new StagedPricingInitializationError(
      "staged_initialization_response_invalid",
      `Seller Portal returned an invalid staged pricing initialization response (${diagnostics}).`,
    );
  }
  return uploadId;
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
