import { useEffect, useRef, useState } from "react";
import {
  clearSavedShippingWorkflow,
  getSavedShippingWorkflowStorage,
  readSavedShippingWorkflow,
  writeSavedShippingWorkflow,
  type SavedShippingWorkflow,
  type SavedShippingWorkflowInput,
} from "../services/savedShippingWorkflow";

/** Saves run this long after the last change so bursts of edits coalesce. */
const SAVE_DELAY_MS = 300;

interface UseSavedShippingWorkflowOptions {
  /** Memoized, so a new object means the workflow actually changed. */
  input: SavedShippingWorkflowInput;
  /** Applies a saved workflow to component state. Called at most once, on mount. */
  onRestore: (saved: SavedShippingWorkflow) => Promise<void> | void;
}

/**
 * Keeps the outbound shipping workflow in localStorage so a refresh does not
 * lose loaded orders or progress. Restores once on mount, then saves after
 * every change, flushing any pending save when the page is left.
 *
 * The saved workflow is shared by every tab on this origin; the last tab to
 * change it wins.
 */
export function useSavedShippingWorkflow({ input, onRestore }: UseSavedShippingWorkflowOptions) {
  const [storage] = useState(getSavedShippingWorkflowStorage);
  const [hasRestored, setHasRestored] = useState(false);
  const [restoredWorkflow, setRestoredWorkflow] = useState<SavedShippingWorkflow | null>(null);
  const pendingInputRef = useRef<SavedShippingWorkflowInput | null>(null);

  useEffect(() => {
    const saved = storage && readSavedShippingWorkflow(storage);

    if (!storage || !saved) {
      setHasRestored(true);
      return;
    }

    void (async () => {
      try {
        await onRestore(saved);
        setRestoredWorkflow(saved);
      } catch (error) {
        console.warn("Failed to restore the saved shipping workflow.", error);
        clearSavedShippingWorkflow(storage);
      } finally {
        setHasRestored(true);
      }
    })();
    // Restores once with the mount-time callback; later renders must not restore again.
  }, []);

  useEffect(() => {
    if (!storage || !hasRestored) {
      return;
    }

    pendingInputRef.current = input;

    const timeoutId = window.setTimeout(() => {
      pendingInputRef.current = null;
      writeSavedShippingWorkflow(storage, input);
    }, SAVE_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [storage, hasRestored, input]);

  useEffect(() => {
    if (!storage) {
      return;
    }

    const flushPendingSave = () => {
      if (pendingInputRef.current) {
        writeSavedShippingWorkflow(storage, pendingInputRef.current);
        pendingInputRef.current = null;
      }
    };

    window.addEventListener("pagehide", flushPendingSave);

    return () => {
      window.removeEventListener("pagehide", flushPendingSave);
      flushPendingSave();
    };
  }, [storage]);

  const dismissRestoredWorkflow = () => {
    setRestoredWorkflow(null);
  };

  return { restoredWorkflow, dismissRestoredWorkflow };
}
