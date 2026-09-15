import assert from "node:assert/strict";
import {
  ANONYMOUS_SALES_LIMIT,
  SalesHistoryUnavailableError,
  couldBeAnonymousSalesHistory,
} from "./salesHistoryAccess";
import { assertSalesHistoryAccess } from "./salesHistoryAccess.server";

{
  assert.equal(couldBeAnonymousSalesHistory(ANONYMOUS_SALES_LIMIT, 100), true);
  assert.equal(
    couldBeAnonymousSalesHistory(ANONYMOUS_SALES_LIMIT, undefined),
    true,
  );
  assert.equal(couldBeAnonymousSalesHistory(ANONYMOUS_SALES_LIMIT - 1, 100), false);
  assert.equal(couldBeAnonymousSalesHistory(ANONYMOUS_SALES_LIMIT + 1, 100), false);
  assert.equal(
    couldBeAnonymousSalesHistory(ANONYMOUS_SALES_LIMIT, ANONYMOUS_SALES_LIMIT),
    false,
    "a fetch that only asked for five sales says nothing about the session",
  );
  console.log("PASS exactly five sales from a larger request could be the signed-out view");
}

{
  const asked: number[] = [];
  await assertSalesHistoryAccess({
    findBusiestProduct: async () => 704784,
    fetchReportedSalesTotal: async (productId) => {
      asked.push(productId);
      return 4470;
    },
  });
  assert.deepEqual(asked, [704784]);
  console.log("PASS a busy product still reporting many sales confirms full history");
}

{
  await assert.rejects(
    assertSalesHistoryAccess({
      findBusiestProduct: async () => 704784,
      fetchReportedSalesTotal: async () => ANONYMOUS_SALES_LIMIT,
    }),
    (error: unknown) =>
      error instanceof SalesHistoryUnavailableError &&
      error.message.includes("product 704784") &&
      error.message.includes("HTTP configuration"),
  );
  console.log("PASS a busy product reporting only five sales means the session is signed out");
}

{
  let fetched = 0;
  await assertSalesHistoryAccess({
    findBusiestProduct: async () => undefined,
    fetchReportedSalesTotal: async () => {
      fetched += 1;
      return 0;
    },
  });
  assert.equal(fetched, 0);
  console.log("PASS an empty ledger has nothing to check against and trusts the answer");
}
