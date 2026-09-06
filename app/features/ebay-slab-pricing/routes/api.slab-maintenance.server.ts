import { data } from "react-router";
import { readSlabJsonRequest } from "../readJsonRequest.server";
import { SlabInventoryError } from "../inventory/slabInventory";
import {
  automaticSlabPublication,
  SlabMaintenanceError,
} from "../maintenance/slabMaintenance";
import {
  getMaintenanceSettings,
  saveMaintenanceSettings,
  maintenanceOverview,
} from "../maintenance/slabMaintenanceStore.server";
import { getProviderConnections } from "../connections/providerConnections.server";
import { ensureEvidenceWorker } from "../evidence/evidenceRefreshWorker.server";
const respond = (body: unknown, status = 200) =>
  data(body, { status, headers: { "Cache-Control": "no-store" } });
const failure = (error: unknown) =>
  respond(
    {
      error:
        error instanceof SlabMaintenanceError ||
        error instanceof SlabInventoryError
          ? error.message
          : "Maintenance is unavailable.",
    },
    error instanceof SlabMaintenanceError ||
      error instanceof SlabInventoryError ||
      error instanceof TypeError ||
      error instanceof SyntaxError
      ? 400
      : 500,
  );
export async function maintenanceView(seller: string) {
  const settings = await getMaintenanceSettings(seller);
  if (settings.enabled) ensureEvidenceWorker();
  return {
    settings,
    items: await maintenanceOverview(seller),
    providers: await getProviderConnections(),
    automaticPublication: automaticSlabPublication(),
    workerMode:
      process.env.WORKERS_RUN_IN_PROCESS === "false"
        ? "external"
        : "in-process",
  };
}
export type MaintenanceView = Awaited<ReturnType<typeof maintenanceView>>;
export async function loader({ request }: { request: Request }) {
  try {
    return respond(
      await maintenanceView(
        new URL(request.url).searchParams.get("seller") ?? "",
      ),
    );
  } catch (error) {
    return failure(error);
  }
}
export async function action({ request }: { request: Request }) {
  if (request.method !== "POST")
    return respond({ error: "Method not allowed." }, 405);
  if (request.headers.get("Origin") !== new URL(request.url).origin)
    return respond({ error: "Change maintenance from the application." }, 403);
  try {
    const input = await readSlabJsonRequest(request, 16384);
    if (input.intent !== "save" || input.autoPublish === true)
      throw new SlabMaintenanceError(
        "Save evidence maintenance settings. Automatic publication is unavailable.",
      );
    const settings = await saveMaintenanceSettings(input.settings);
    if (settings.enabled) ensureEvidenceWorker();
    return respond({
      settings,
      automaticPublication: automaticSlabPublication(),
    });
  } catch (error) {
    return failure(error);
  }
}
