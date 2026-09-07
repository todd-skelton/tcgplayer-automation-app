import { data } from "react-router";
import { inventoryOpeningBalancesRepository } from "~/core/db";
import { getShippingExportConfig } from "~/features/shipping-export/config/shippingExportConfig.server";
import { captureInventoryObservation } from "../services/captureInventoryObservation.server";
import { applyInventoryOpeningBalance } from "../services/applyInventoryOpeningBalance.server";

export function createInventoryOpeningBalanceAction(dependencies = {
  capture: captureInventoryObservation,
  preview: inventoryOpeningBalancesRepository.preview,
  apply: applyInventoryOpeningBalance,
  acknowledgeDifference: inventoryOpeningBalancesRepository.acknowledgeDifference,
  listDifferences: inventoryOpeningBalancesRepository.listDifferences,
  listObservationItems: inventoryOpeningBalancesRepository.listObservationItems,
  listPreviewItems: inventoryOpeningBalancesRepository.listPreviewItems,
  getConfig: getShippingExportConfig,
}) {
  return async ({ request }: { request: Request }) => {
    if (request.method !== "POST") return data({ error: "Method not allowed" }, { status: 405 });
    try {
      const payload = await request.json() as Record<string, unknown>;
      const configured = (await dependencies.getConfig()).defaultSellerKey.trim();
      const sellerKey = typeof payload.sellerKey === "string" ? payload.sellerKey.trim() : configured;
      if (!sellerKey || sellerKey !== configured) return data({ error: "Seller key must match the configured seller." }, { status: 400 });
      if (payload.action === "capture") {
        if (typeof payload.requestId !== "string") return data({ error: "Request ID is required." }, { status: 400 });
        return data({ observation: await dependencies.capture({ requestId: payload.requestId, sellerKey }) });
      }
      if (payload.action === "preview") {
        if (typeof payload.requestId !== "string" || typeof payload.observationId !== "string") return data({ error: "Request and observation IDs are required." }, { status: 400 });
        return data({ preview: await dependencies.preview({ requestId: payload.requestId, sellerKey, observationId: payload.observationId }) });
      }
      if (payload.action === "apply") {
        if (typeof payload.requestId !== "string" || typeof payload.runId !== "string" || typeof payload.evidenceFingerprint !== "string") return data({ error: "Request ID, run ID, and evidence fingerprint are required." }, { status: 400 });
        return data({ result: await dependencies.apply({requestId:payload.requestId,runId:payload.runId,evidenceFingerprint:payload.evidenceFingerprint,sellerKey}) });
      }
      if (payload.action === "acknowledge_difference") {
        if (typeof payload.requestId !== "string" || typeof payload.differenceId !== "string" || typeof payload.note !== "string") return data({ error: "Request ID, difference ID, and acknowledgement note are required." }, { status: 400 });
        return data({ result: await dependencies.acknowledgeDifference({requestId:payload.requestId,id:payload.differenceId,sellerKey,note:payload.note}) });
      }
      if (payload.action === "list_differences") {
        if (typeof payload.observationId !== "string") return data({ error: "Observation ID is required." }, { status: 400 });
        return data({ differences: await dependencies.listDifferences({sellerKey,observationId:payload.observationId,
          ...(typeof payload.afterId==="string"?{afterId:payload.afterId}:{}),
          ...(typeof payload.limit==="number"?{limit:payload.limit}:{})}) });
      }
      if (payload.action === "list_observation_items") {
        if (typeof payload.observationId !== "string") return data({ error: "Observation ID is required." }, { status: 400 });
        return data({ items: await dependencies.listObservationItems({sellerKey,observationId:payload.observationId,
          ...(typeof payload.afterInventoryKey==="string"?{afterInventoryKey:payload.afterInventoryKey}:{}),
          ...(typeof payload.limit==="number"?{limit:payload.limit}:{}),
          ...(typeof payload.unsupportedOnly==="boolean"?{unsupportedOnly:payload.unsupportedOnly}:{})}) });
      }
      if (payload.action === "list_preview_items") {
        if (typeof payload.runId !== "string") return data({ error: "Run ID is required." }, { status: 400 });
        return data({ items: await dependencies.listPreviewItems({sellerKey,runId:payload.runId,
          ...(typeof payload.afterSku==="number"?{afterSku:payload.afterSku}:{}),
          ...(typeof payload.limit==="number"?{limit:payload.limit}:{})}) });
      }
      return data({ error: "Unknown opening balance action." }, { status: 400 });
    } catch (error) {
      return data({ error: String(error) }, { status: 409 });
    }
  };
}
