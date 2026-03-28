import { inventoryBatchesRepository } from "~/core/db";
import { ensureInventoryBatchPricingWorker } from "../services/inventoryBatchPricingWorker.server";

const POLL_MS = 1_000;
const HEARTBEAT_MS = 15_000;

function parseBatchNumber(rawValue: string | undefined): number | null {
  const batchNumber = Number(rawValue);
  return Number.isInteger(batchNumber) && batchNumber > 0 ? batchNumber : null;
}

function encodeEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function getBatchVersion(batch: Awaited<ReturnType<typeof inventoryBatchesRepository.findByBatchNumber>>): string {
  if (!batch) {
    return "missing";
  }

  return JSON.stringify({
    batchUpdatedAt: batch.updatedAt,
    batchStatus: batch.status,
    lastPricedAt: batch.lastPricedAt,
    latestJobId: batch.latestJob?.id ?? null,
    latestJobStatus: batch.latestJob?.status ?? null,
    latestJobUpdatedAt: batch.latestJob?.updatedAt ?? null,
    latestJobError: batch.latestJob?.errorMessage ?? null,
  });
}

export async function loader({
  params,
  request,
}: {
  params: { batchNumber?: string };
  request: Request;
}) {
  const batchNumber = parseBatchNumber(params.batchNumber);
  if (!batchNumber) {
    return new Response(JSON.stringify({ error: "Invalid batch number" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  ensureInventoryBatchPricingWorker();

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let pollTimer: NodeJS.Timeout | null = null;
      let heartbeatTimer: NodeJS.Timeout | null = null;
      let lastVersion = "";

      const cleanup = () => {
        if (closed) {
          return;
        }

        closed = true;
        if (pollTimer) {
          clearInterval(pollTimer);
        }
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
      };

      const pushSnapshot = async () => {
        const batch = await inventoryBatchesRepository.findByBatchNumber(batchNumber);

        if (!batch) {
          controller.enqueue(
            encoder.encode(
              encodeEvent("error", { error: `Batch ${batchNumber} not found` }),
            ),
          );
          cleanup();
          controller.close();
          return;
        }

        const version = getBatchVersion(batch);
        if (version === lastVersion) {
          return;
        }

        lastVersion = version;
        controller.enqueue(encoder.encode(encodeEvent("batch", { batch })));
      };

      request.signal.addEventListener("abort", () => {
        cleanup();
        controller.close();
      });

      await pushSnapshot();

      pollTimer = setInterval(() => {
        void pushSnapshot();
      }, POLL_MS);

      heartbeatTimer = setInterval(() => {
        if (!closed) {
          controller.enqueue(encoder.encode(encodeEvent("heartbeat", {})));
        }
      }, HEARTBEAT_MS);
    },
    cancel() {
      // The abort listener handles cleanup.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
