import { ProviderRequestError } from "../connections/providerRequest.server";
import { runSlabMaintenanceCycle } from "../maintenance/slabMaintenanceCycle.server";
import { fetchEvidence } from "./evidenceRefreshProvider.server";
import {
  claimEvidenceJob,
  cleanEvidenceCache,
  completeEvidenceJob,
  evidenceJobActive,
  failEvidenceJob,
  type EvidenceJob,
} from "./evidenceRefreshStore.server";

export async function runEvidenceJob(
  job: EvidenceJob,
  options: { fetch?: typeof fetchEvidence; signal?: AbortSignal } = {},
) {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([
        controller.signal,
        options.signal,
        AbortSignal.timeout(60_000),
      ])
    : AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
  let checking = false;
  const check = setInterval(() => {
    if (checking) return;
    checking = true;
    void evidenceJobActive(job)
      .then((active) => {
        if (!active) controller.abort();
      })
      .catch(() => controller.abort())
      .finally(() => {
        checking = false;
      });
  }, 5_000);
  const started = performance.now();
  try {
    if (!(await evidenceJobActive(job))) return false;
    signal.throwIfAborted();
    const payload = await (options.fetch ?? fetchEvidence)(job.spec, signal);
    signal.throwIfAborted();
    return await completeEvidenceJob(job, payload, performance.now() - started);
  } catch (error) {
    const code = signal.aborted
      ? "unavailable"
      : error instanceof ProviderRequestError
        ? error.status === "cancelled"
          ? "unavailable"
          : error.status
        : "invalid-response";
    await failEvidenceJob(
      job,
      code,
      ["busy", "rate-limited", "unavailable"].includes(code),
    );
    return false;
  } finally {
    clearInterval(check);
  }
}

type Worker = {
  timer: ReturnType<typeof setTimeout> | null;
  controller: AbortController;
  running: boolean;
  lastCleanup: number;
  pending: Promise<void> | null;
  wake: () => void;
};
// One process-level loop, including dev hot reloads. Slab jobs never occupy a TCG pricing worker.
const scope = globalThis as typeof globalThis & { slabEvidenceWorker?: Worker };
export function ensureEvidenceWorker() {
  if (process.env.WORKERS_RUN_IN_PROCESS === "false") return;
  if (
    scope.slabEvidenceWorker &&
    !scope.slabEvidenceWorker.controller.signal.aborted
  ) {
    scope.slabEvidenceWorker.wake();
    return;
  }
  startEvidenceWorker();
}
export function startEvidenceWorker() {
  if (
    scope.slabEvidenceWorker &&
    !scope.slabEvidenceWorker.controller.signal.aborted
  )
    return;
  const worker: Worker = {
    timer: null,
    controller: new AbortController(),
    running: false,
    lastCleanup: 0,
    pending: null,
    wake: () => {},
  };
  scope.slabEvidenceWorker = worker;
  const tick = async () => {
    if (worker.controller.signal.aborted || worker.running) return;
    worker.running = true;
    let waitMs = 30_000;
    try {
      const job = await claimEvidenceJob();
      if (job) {
        waitMs = 2_000;
        await runEvidenceJob(job, { signal: worker.controller.signal });
      } else {
        const maintenance = await runSlabMaintenanceCycle();
        if (maintenance?.queued) waitMs = 2000;
      }
      if (Date.now() - worker.lastCleanup > 3600_000) {
        await cleanEvidenceCache();
        worker.lastCleanup = Date.now();
      }
    } catch {
      console.warn(
        "[slab-evidence-worker] Refresh unavailable; retrying later.",
      );
    } finally {
      worker.running = false;
      if (!worker.controller.signal.aborted) {
        worker.timer = setTimeout(() => {
          worker.pending = tick();
        }, waitMs);
        worker.timer.unref();
      }
    }
  };
  worker.wake = () => {
    if (!worker.running && !worker.controller.signal.aborted) {
      if (worker.timer) clearTimeout(worker.timer);
      worker.pending = tick();
    }
  };
  worker.wake();
}
export async function stopEvidenceWorker() {
  const worker = scope.slabEvidenceWorker;
  if (!worker) return;
  worker.controller.abort();
  if (worker.timer) clearTimeout(worker.timer);
  await worker.pending;
}
