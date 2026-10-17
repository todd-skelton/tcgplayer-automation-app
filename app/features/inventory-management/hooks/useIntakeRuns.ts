import { useCallback, useEffect, useState } from "react";
import type {
  IntakePublicationTarget,
  InventoryIntakeRun,
} from "../types/inventoryIntakeRun";

const POLL_INTERVAL_MS = 5000;

/**
 * Polls the background batches and the seller they publish for. The target
 * gates queuing, so it is null whenever the latest status could not be loaded.
 */
export function useIntakeRuns() {
  const [runs, setRuns] = useState<InventoryIntakeRun[]>([]);
  const [target, setTarget] = useState<IntakePublicationTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch("/api/inventory-intake-runs", {
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(
            "Batch status could not be refreshed. Previously shown status may be out of date.",
          );
        const next = await response.json();
        if (!controller.signal.aborted) {
          setRuns(next.runs);
          setTarget(next.target);
          setError(null);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(error instanceof Error ? error.message : String(error));
          setTarget(null);
        }
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void load(), POLL_INTERVAL_MS);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [reloadKey]);

  const reload = useCallback(() => setReloadKey((value) => value + 1), []);

  return { runs, target, error, reload };
}
