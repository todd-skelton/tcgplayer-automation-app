import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  InventoryBatchPublicationApiResponse,
  InventoryPublication,
} from "../types/inventoryPublication";

const ACTIVE_PUBLICATION_STATUSES = new Set<InventoryPublication["status"]>([
  "planned",
  "staging",
  "staged",
  "publishing",
]);

export function useInventoryBatchPublication(batchNumber?: number) {
  const [state, setState] =
    useState<InventoryBatchPublicationApiResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!batchNumber) {
      setState(null);
      return null;
    }

    setIsLoading(true);
    try {
      const response = await fetch(
        `/api/inventory-batches/${batchNumber}/publications`,
      );
      const payload = (await response.json()) as
        | InventoryBatchPublicationApiResponse
        | { error?: string };
      if (!response.ok) {
        throw new Error(
          "error" in payload && payload.error
            ? payload.error
            : "Failed to load publication preview",
        );
      }

      const nextState = payload as InventoryBatchPublicationApiResponse;
      setState(nextState);
      setError(null);
      return nextState;
    } catch (loadError) {
      setError(String(loadError));
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [batchNumber]);

  useEffect(() => {
    void load();
  }, [load]);

  const latestPublication = state?.publications[0] ?? null;
  const hasActivePublication = Boolean(
    state?.publications.some((publication) =>
      ACTIVE_PUBLICATION_STATUSES.has(publication.status),
    ),
  );

  useEffect(() => {
    if (!batchNumber || !hasActivePublication) {
      return;
    }

    const timer = window.setInterval(() => {
      void load();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [batchNumber, hasActivePublication, load]);

  const publish = useCallback(
    async (selectedSkus: readonly number[]) => {
      if (!batchNumber) {
        throw new Error("Select a batch before publishing.");
      }

      setIsSubmitting(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/inventory-batches/${batchNumber}/publications`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ selectedSkus }),
          },
        );
        const payload = (await response.json()) as
          | {
              publications: InventoryPublication[];
              createdCount: number;
            }
          | { error?: string };
        if (!response.ok) {
          throw new Error(
            "error" in payload && payload.error
              ? payload.error
              : "Failed to publish inventory batch",
          );
        }

        await load();
        return payload as {
          publications: InventoryPublication[];
          createdCount: number;
        };
      } catch (publishError) {
        setError(String(publishError));
        throw publishError;
      } finally {
        setIsSubmitting(false);
      }
    },
    [batchNumber, load],
  );

  const currentPlanAlreadyExists = useMemo(() => {
    const planningKey = state?.preview?.planningKey;
    return Boolean(
      planningKey &&
      state?.publications.some(
        (publication) => publication.planningKey === planningKey,
      ),
    );
  }, [state]);

  return {
    preview: state?.preview ?? null,
    publications: state?.publications ?? [],
    latestPublication,
    hasActivePublication,
    currentPlanAlreadyExists,
    isLoading,
    isSubmitting,
    error,
    load,
    publish,
  };
}
