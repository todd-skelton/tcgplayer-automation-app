import pLimit from "p-limit";
import { randomUUID } from "node:crypto";
import { sellerOrderHistoryRepository } from "~/core/db";
import {
  getSellerOrder,
  type SellerOrderDetail,
} from "~/integrations/tcgplayer/client/get-seller-order.server";
import {
  searchSellerOrders,
  type SearchSellerOrdersRequest,
  type SearchSellerOrdersResponse,
  type SellerOrderSearchSummary,
} from "~/integrations/tcgplayer/client/search-seller-orders.server";
import { observeSellerOrder } from "../domain/sellerOrderObservation";
import { fingerprintSellerOrderSummary } from "../domain/sellerOrderObservation";
import type { SellerOrderSyncResult } from "../types/sellerOrderHistory";

const SEARCH_RANGE = "LastThreeMonths" as const;
const ORDER_DATE_SORT = [{ sortingType: "orderDate", direction: "ascending" }];

function sanitizeSummary(summary: SellerOrderSearchSummary) {
  return {
    orderNumber: summary.orderNumber,
    orderDate: summary.orderDate,
    orderChannel: summary.orderChannel,
    orderStatus: summary.orderStatus,
    shippingType: summary.shippingType,
    productAmount: summary.productAmount,
    shippingAmount: summary.shippingAmount,
    totalAmount: summary.totalAmount,
    buyerPaid: summary.buyerPaid,
    orderFulfillment: summary.orderFulfillment,
  };
}

export interface SellerOrderSyncBudget {
  maxPages: number;
  maxDetails: number;
  pageSize: number;
  detailConcurrency: number;
}

const DEFAULT_BUDGET: SellerOrderSyncBudget = {
  maxPages: 1,
  maxDetails: 25,
  pageSize: 500,
  detailConcurrency: 5,
};

interface SyncDependencies {
  searchOrders: (
    request: SearchSellerOrdersRequest,
    options?: { signal?: AbortSignal; retry?: boolean },
  ) => Promise<SearchSellerOrdersResponse>;
  getOrder: (
    orderNumber: string,
    options?: { signal?: AbortSignal; retry?: boolean },
  ) => Promise<SellerOrderDetail>;
  now: () => Date;
  repository: typeof sellerOrderHistoryRepository;
}

const defaultDependencies: SyncDependencies = {
  searchOrders: searchSellerOrders,
  getOrder: getSellerOrder,
  now: () => new Date(),
  repository: sellerOrderHistoryRepository,
};

async function boundedRequest<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  const controller = new AbortController();
  let rejectOnAbort: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => rejectOnAbort?.(new Error("Seller order request timed out."));
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([request(controller.signal), aborted]);
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be positive.`);
  return value;
}

async function fetchAndRecordDetails(input: {
  sellerKey: string;
  summaries: SellerOrderSearchSummary[];
  dependencies: SyncDependencies;
  concurrency: number;
  runId: string;
  claimToken: string;
}): Promise<{ changed: string[]; recorded: number; gaps: SellerOrderSearchSummary[]; times: string[] }> {
  const limit = pLimit(input.concurrency);
  const results = await Promise.all(input.summaries.map((summary) => limit(async () => {
    try {
      const detail = await boundedRequest((signal) =>
        input.dependencies.getOrder(summary.orderNumber, { signal, retry: false }));
      if (detail.orderNumber.trim() !== summary.orderNumber.trim()) {
        throw new Error("detail order number did not match search result");
      }
      const observation = observeSellerOrder(
        input.sellerKey,
        summary,
        detail,
        input.dependencies.now().toISOString(),
      );
      const stored = await input.dependencies.repository.recordApiObservation(
        input.runId,
        input.claimToken,
        observation,
      );
      return { orderNumber: detail.orderNumber, changed: stored.changed, time: detail.createdAt };
    } catch (error) {
      console.warn(
        `Seller order ${summary.orderNumber} detail was not recorded: ${String(error)}`,
      );
      return { orderNumber: summary.orderNumber, changed: false };
    }
  })));
  return {
    changed: results.filter((result) => result.changed).map((result) => result.orderNumber),
    recorded: results.filter((result) => "time" in result).length,
    gaps: results.flatMap((result, index) =>
      !("time" in result) && input.summaries[index] ? [input.summaries[index]!] : []),
    times: results.flatMap((result) => "time" in result && result.time ? [result.time] : []),
  };
}

/**
 * Advances one durable API scan within a strict request budget. Repeating this
 * function resumes the same scan until every page and detail succeeds.
 */
export async function synchronizeSellerOrders(
  sellerKey: string,
  budget: Partial<SellerOrderSyncBudget> = {},
  overrides: Partial<SyncDependencies> = {},
  priorityOrderNumbers: string[] = [],
): Promise<SellerOrderSyncResult> {
  const normalizedSellerKey = sellerKey.trim();
  if (!normalizedSellerKey) throw new Error("Seller key is required.");
  const limits = { ...DEFAULT_BUDGET, ...budget };
  positiveInteger(limits.maxPages, "maxPages");
  positiveInteger(limits.maxDetails, "maxDetails");
  positiveInteger(limits.pageSize, "pageSize");
  positiveInteger(limits.detailConcurrency, "detailConcurrency");
  if (limits.maxPages > 4 || limits.maxDetails > 100 || limits.pageSize > 500) {
    throw new Error("Seller order sync budget exceeds the safe request limit.");
  }
  const dependencies = { ...defaultDependencies, ...overrides };
  const claimToken = randomUUID();
  const acquired = await dependencies.repository.startOrResumeApiRun(
    normalizedSellerKey,
    claimToken,
  );
  if (!acquired.acquired) {
    return {
      coverage: await dependencies.repository.getCoverage(normalizedSellerKey),
      changedOrderNumbers: [],
    };
  }
  const run = acquired.run;
  const changedOrderNumbers = new Set<string>();
  let detailBudget = limits.maxDetails;
  let nextOffset = run.nextOffset;
  let expectedTotal = run.expectedTotal;
  let hasObservedSearchPage = run.pagesCompleted > 0;
  let gaps = [...(run.gaps ?? [])];

  try {
    const requestedPriority = [...new Set(
      priorityOrderNumbers.map((value) => value.trim()).filter(Boolean),
    )].slice(0, detailBudget);
    const verifiedPriority = new Set(
      await dependencies.repository.findApiVerifiedOrderNumbers(
        normalizedSellerKey,
        requestedPriority,
      ),
    );
    const verifiedSummaries = new Map<string, SellerOrderSearchSummary>();
    for (const orderNumber of requestedPriority) {
      if (verifiedPriority.has(orderNumber)) continue;
      const response = await boundedRequest((signal) => dependencies.searchOrders({
        searchRange: SEARCH_RANGE,
        query: { orderNumber },
        filters: { sellerKey: normalizedSellerKey },
        sortBy: ORDER_DATE_SORT,
        from: 0,
        size: 25,
      }, { signal, retry: false }));
      const match = response.orders.find((order) => order.orderNumber === orderNumber);
      if (match) verifiedSummaries.set(orderNumber, match);
    }
    const priority = requestedPriority.filter(
      (orderNumber) => verifiedPriority.has(orderNumber) || verifiedSummaries.has(orderNumber),
    );
    if (priority.length > 0) {
      const priorityResult = await fetchAndRecordDetails({
        sellerKey: normalizedSellerKey,
        summaries: priority.map((orderNumber) => verifiedSummaries.get(orderNumber) ?? ({
            orderNumber, orderDate: "", orderChannel: "", orderStatus: "",
            buyerName: "", shippingType: "", productAmount: 0, shippingAmount: 0,
            totalAmount: 0, buyerPaid: false, orderFulfillment: "",
          })),
        dependencies,
        concurrency: limits.detailConcurrency,
        runId: run.id,
        claimToken,
      });
      priorityResult.changed.forEach((number) => changedOrderNumbers.add(number));
      const failedPriority = priorityResult.gaps.map((summary) => ({
        orderNumber: summary.orderNumber,
      }));
      gaps = [
        ...failedPriority,
        ...gaps.filter((gap) => !priority.includes(gap.orderNumber)),
      ];
      detailBudget -= priority.length;
      await dependencies.repository.saveApiProgress({
        runId: run.id, claimToken, nextOffset, expectedTotal, pageOrderCount: 0,
        pageCompleted: false, detailCount: priorityResult.recorded,
        observedTimes: priorityResult.times, gaps, complete: false,
      });
    }
    if (gaps.length > 0 && detailBudget > 0) {
      const retryGaps = gaps.slice(0, detailBudget);
      const retry = await fetchAndRecordDetails({
        sellerKey: normalizedSellerKey,
        summaries: retryGaps.map((gap) => gap.summary ? {
          ...gap.summary,
          buyerName: "",
        } : ({
          orderNumber: gap.orderNumber,
          orderDate: "",
          orderChannel: "",
          orderStatus: "",
          buyerName: "",
          shippingType: "",
          productAmount: 0,
          shippingAmount: 0,
          totalAmount: 0,
          buyerPaid: false,
          orderFulfillment: "",
        })),
        dependencies,
        concurrency: limits.detailConcurrency,
        runId: run.id,
        claimToken,
      });
      retry.changed.forEach((number) => changedOrderNumbers.add(number));
      gaps = [
        ...retry.gaps.map((summary) => ({
          orderNumber: summary.orderNumber,
          summary: sanitizeSummary(summary),
        })),
        ...gaps.slice(retryGaps.length),
      ];
      detailBudget -= retryGaps.length;
      await dependencies.repository.saveApiProgress({
        runId: run.id, claimToken, nextOffset, expectedTotal, pageOrderCount: 0,
        pageCompleted: false, detailCount: retry.recorded,
        observedTimes: retry.times, gaps, complete: false,
      });
      if (detailBudget === 0) {
        const complete = hasObservedSearchPage && expectedTotal !== null &&
          nextOffset >= expectedTotal && gaps.length === 0;
        return {
          coverage: await dependencies.repository.finishApiRun(
            run.id, claimToken, complete,
            complete ? undefined : "Detail retry budget was exhausted before all gaps were resolved.",
          ),
          changedOrderNumbers: [...changedOrderNumbers],
        };
      }
    }

    let coverage = await dependencies.repository.getCoverage(normalizedSellerKey);
    for (let page = 0; page < limits.maxPages && detailBudget > 0; page += 1) {
      const size = limits.pageSize;
      const overlap = nextOffset === 0
        ? 0
        : Math.min(size - 1, 25, Math.max(1, Math.floor(size / 10)));
      const pageOffset = Math.max(0, nextOffset - overlap);
      const response = await boundedRequest((signal) => dependencies.searchOrders({
          searchRange: SEARCH_RANGE,
          filters: { sellerKey: normalizedSellerKey },
          sortBy: ORDER_DATE_SORT,
          from: pageOffset,
          size,
        }, { signal, retry: false }));
      expectedTotal = response.totalOrders;
      if (response.orders.length === 0 && pageOffset < expectedTotal) {
        return {
          coverage: await dependencies.repository.restartInconsistentApiRun(
            run.id,
            claimToken,
            `Search returned an empty page at offset ${pageOffset} before reported total ${expectedTotal}.`,
          ),
          changedOrderNumbers: [...changedOrderNumbers],
        };
      }
      const neededNumbers = new Set(await dependencies.repository.findDetailsNeeded(
        normalizedSellerKey,
        response.orders.map((summary) => ({
          orderNumber: summary.orderNumber,
          summaryFingerprint: fingerprintSellerOrderSummary(summary),
        })),
        new Date(dependencies.now().getTime() - 24 * 60 * 60 * 1_000),
      ));
      const neededSummaries = response.orders.filter((summary) => neededNumbers.has(summary.orderNumber));
      const summariesToFetch = neededSummaries.slice(0, detailBudget);
      const deferredSummaries = neededSummaries.slice(detailBudget);
      const detailResult = await fetchAndRecordDetails({
        sellerKey: normalizedSellerKey,
        summaries: summariesToFetch,
        dependencies,
        concurrency: limits.detailConcurrency,
        runId: run.id,
        claimToken,
      });
      detailResult.changed.forEach((number) => changedOrderNumbers.add(number));
      const gapsByOrder = new Map(gaps.map((gap) => [gap.orderNumber, gap]));
      for (const summary of [...detailResult.gaps, ...deferredSummaries]) {
        gapsByOrder.set(summary.orderNumber, {
          orderNumber: summary.orderNumber,
          summary: sanitizeSummary(summary),
        });
      }
      gaps = [...gapsByOrder.values()];
      nextOffset = Math.max(nextOffset, pageOffset + response.orders.length);
      detailBudget -= summariesToFetch.length;
      const reachedEnd = response.orders.length < size || nextOffset >= expectedTotal;
      hasObservedSearchPage = true;
      let complete = reachedEnd && gaps.length === 0;
      const previousUniqueOrders = coverage.ordersObserved;
      coverage = await dependencies.repository.saveApiProgress({
        runId: run.id,
        claimToken,
        nextOffset,
        expectedTotal,
        pageOffset,
        pageOrderCount: response.orders.length,
        pageCompleted: true,
        detailCount: detailResult.recorded,
        observedTimes: [
          ...detailResult.times,
          ...response.orders.map((summary) => summary.orderDate),
        ],
        gaps,
        complete,
        orderNumbers: response.orders.map((order) => order.orderNumber),
      });
      if (
        response.orders.length > 0 &&
        coverage.ordersObserved === previousUniqueOrders &&
        coverage.ordersObserved < expectedTotal
      ) {
        return {
          coverage: await dependencies.repository.restartInconsistentApiRun(
            run.id, claimToken,
            `Search repeated a page without new order identities at offset ${nextOffset - response.orders.length}.`,
          ),
          changedOrderNumbers: [...changedOrderNumbers],
        };
      }
      complete = complete && coverage.ordersObserved >= expectedTotal;
      if (reachedEnd) {
        if (gaps.length === 0 && coverage.ordersObserved < expectedTotal) {
          return {
            coverage: await dependencies.repository.restartInconsistentApiRun(
              run.id,
              claimToken,
              `Search changed during pagination (${coverage.ordersObserved} unique orders for reported total ${expectedTotal}); restarting with overlap.`,
            ),
            changedOrderNumbers: [...changedOrderNumbers],
          };
        }
        return {
          coverage: await dependencies.repository.finishApiRun(
            run.id,
            claimToken,
            complete,
            complete ? undefined : "All search pages were read, but one or more order details are still missing.",
          ),
          changedOrderNumbers: [...changedOrderNumbers],
        };
      }
    }
    return {
      coverage: await dependencies.repository.finishApiRun(
        run.id, claimToken, false, "Sync request budget reached; resume from the saved offset.",
      ),
      changedOrderNumbers: [...changedOrderNumbers],
    };
  } catch (error) {
    const coverage = await dependencies.repository.finishApiRun(
      run.id, claimToken, false, String(error),
    );
    return { coverage, changedOrderNumbers: [...changedOrderNumbers] };
  }
}
