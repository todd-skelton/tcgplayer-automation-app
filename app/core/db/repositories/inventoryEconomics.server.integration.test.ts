import assert from "node:assert/strict";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || process.env.DATABASE_URL !== testUrl) throw new Error("Matching TEST_DATABASE_URL and DATABASE_URL are required.");
if (!new URL(testUrl).pathname.replace(/^\/+/, "").startsWith("tcgplayer_strategy_test_")) {
  throw new Error("Inventory economics integration tests require a disposable tcgplayer_strategy_test_* database.");
}
const { execute, getPool, queryOne } = await import("../database.server");
const { inventoryEconomicsRepository } = await import("./inventoryEconomics.server");
const { sellerOrderHistoryRepository } = await import("./sellerOrderHistory.server");
const { observeSellerOrder } = await import("~/features/seller-order-history/domain/sellerOrderObservation");
const { importPurchaseCostCsv, PURCHASE_COST_CSV_HEADER } = await import("~/features/inventory-economics/services/purchaseCostFileImport.server");
const prefix = `economics-${Date.now()}`;
const sellerKey = `${prefix}-seller`;
const otherSeller = `${prefix}-other`;
const sku = 9_000_000 + Date.now() % 999_999;

try {
  await execute(`INSERT INTO inventory_pending_mutations
    (request_id,mutation_type,sku,requested_quantity,product_line_id,set_id,product_id,quantity_delta,resulting_quantity)
    VALUES ($1,'add',$2,5,1,1,1,5,5)`, [`${prefix}-receipt-request`,sku]);
  const receipt = await queryOne<{ id: number }>(`INSERT INTO inventory_receipts
    (request_id,sku,original_quantity,product_line_id,set_id,product_id,seller_key,market_provenance)
    VALUES ($1,$2,5,1,1,1,$3,'test_unavailable') RETURNING receipt_id AS id`,
    [`${prefix}-receipt-request`,sku,sellerKey]);
  const batch = await queryOne<{ id: number }>(`INSERT INTO inventory_batches (status,source_type,source_label)
    VALUES ('pending','pending_inventory',$1) RETURNING batch_number AS id`, [prefix]);
  assert.ok(receipt && batch);
  await execute(`INSERT INTO inventory_receipt_batch_links (receipt_id,batch_number,linked_quantity) VALUES ($1,$2,5)`, [receipt.id,batch.id]);

  const purchase = { requestId:`${prefix}-purchase-request`,sellerKey,purchaseReference:`${prefix}-purchase`,currency:"USD",
    totalAmountCents:10001,provenance:"actual" as const,source:"manual" as const,allocationRule:"quantity" as const,
    batchNumbers:[batch.id] };
  const firstPurchase = await inventoryEconomicsRepository.recordPurchaseCost(purchase);
  assert.equal((await inventoryEconomicsRepository.recordPurchaseCost(purchase)).entryId, firstPurchase.entryId);
  await assert.rejects(inventoryEconomicsRepository.recordPurchaseCost({...purchase,totalAmountCents:999}), /different inventory economics evidence/);
  const purchaseCorrection = await inventoryEconomicsRepository.recordPurchaseCost({ ...purchase,
    requestId:`${prefix}-purchase-correction`,totalAmountCents:10002,correctsEntryId:firstPurchase.entryId,
    correctionReason:"Corrected invoice total" });
  assert.notEqual(purchaseCorrection.entryId,firstPurchase.entryId);
  assert.equal((await inventoryEconomicsRepository.listPurchaseCosts(sellerKey))[0]?.version,2);
  await assert.rejects(execute(`UPDATE inventory_purchase_cost_entries SET total_amount_cents=1 WHERE id=$1`,[firstPurchase.entryId]),/immutable/);

  const repeatCsv = `${PURCHASE_COST_CSV_HEADER}\n${prefix}-file,${batch.id},2.50,actual,quantity,,USD`;
  assert.equal((await importPurchaseCostCsv(sellerKey,repeatCsv)).repeated,false);
  assert.equal((await importPurchaseCostCsv(sellerKey,repeatCsv)).repeated,true);
  const partialReference = `${prefix}-must-rollback`;
  await assert.rejects(importPurchaseCostCsv(sellerKey,
    `${PURCHASE_COST_CSV_HEADER}\n${partialReference},${batch.id},1.00,actual,quantity,,USD\n${purchase.purchaseReference},${batch.id},9.00,actual,quantity,,USD`),/current entry/);
  assert.equal(await queryOne(`SELECT 1 FROM inventory_purchase_cost_series WHERE purchase_reference=$1`,[partialReference]),null);

  const funding = { requestId:`${prefix}-funding-request`,sellerKey,adjustmentReference:`${prefix}-funding`,currency:"USD",
    adjustmentType:"external_contribution" as const,amountCents:1000,provenance:"actual" as const,effectiveAt:"2026-09-08" };
  const firstFunding = await inventoryEconomicsRepository.recordFundingAdjustment(funding);
  assert.equal((await inventoryEconomicsRepository.recordFundingAdjustment(funding)).entryId, firstFunding.entryId);
  await assert.rejects(inventoryEconomicsRepository.recordFundingAdjustment({...funding,amountCents:9000}), /different inventory economics evidence/);
  await assert.rejects(inventoryEconomicsRepository.recordFundingAdjustment({...funding,sellerKey:otherSeller}), /different inventory economics evidence/);
  await inventoryEconomicsRepository.recordFundingAdjustment({...funding,requestId:`${prefix}-funding-correction`,
    amountCents:1200,correctsEntryId:firstFunding.entryId,correctionReason:"Corrected contribution receipt"});
  assert.equal((await inventoryEconomicsRepository.listFundingAdjustments(sellerKey))[0]?.version,2);

  const orderNumber = `${prefix}-order`;
  const order = await sellerOrderHistoryRepository.recordObservation(observeSellerOrder(sellerKey,undefined,{
    createdAt:"2026-09-01T00:00:00Z",status:"Completed - Paid",orderChannel:"TcgMarketplace",orderFulfillment:"Normal",
    orderNumber,sellerName:"",buyerName:"",paymentType:"",pickupStatus:"",shippingType:"Standard",estimatedDeliveryDate:"",
    transaction:{productAmount:10,shippingAmount:1,grossAmount:11,feeAmount:1,netAmount:10,directFeeAmount:0,taxes:[{code:"STATE",amount:0.8}]},
    shippingAddress:{recipientName:"",addressOne:"",city:"",territory:"",country:"US",postalCode:""},
    products:[{name:"Synthetic",unitPrice:10,extendedPrice:10,quantity:1,url:"",productId:"1",skuId:String(sku)}],
    refunds:[],refundStatus:"No Refund",trackingNumbers:[],allowedActions:[],
  }));
  const storedTransaction = await queryOne<{ net: number; evidence: { taxes: unknown[] } }>(
    `SELECT provider_net_proceeds::float8 AS net,transaction_evidence AS evidence FROM seller_orders WHERE id=$1`,[order.orderId]);
  assert.equal(storedTransaction?.net,10); assert.equal(storedTransaction?.evidence.taxes.length,1);
  const expense = { requestId:`${prefix}-expense-request`,sellerKey,expenseReference:`${prefix}-expense`,currency:"USD",
    expenseType:"fulfillment" as const,amountCents:0,provenance:"actual" as const,
    orderNumbers:[orderNumber],expenseAt:"2026-09-02",basis:"additional_expense" as const };
  const firstExpense = await inventoryEconomicsRepository.recordOrderExpense(expense);
  assert.equal((await inventoryEconomicsRepository.recordOrderExpense(expense)).entryId, firstExpense.entryId);
  await assert.rejects(inventoryEconomicsRepository.recordOrderExpense({...expense,currency:"CAD"}), /different inventory economics evidence/);

  await execute(`INSERT INTO shipping_postage_purchases
    (shipment_reference,order_numbers,mode,direction,label_size,easypost_shipment_id,selected_rate_rate,selected_rate_currency,status)
    VALUES ($1,$2,'production','return','4x6',$3,'7.01','USD','purchased')`,
    [`${prefix}-shipment`,[orderNumber],`${prefix}-provider`]);
  const evidence = await inventoryEconomicsRepository.findWorkspaceEvidence(sellerKey);
  assert.equal(evidence.postage[0]?.rateCents, 701);
  assert.equal(evidence.postage[0]?.direction, "return");
  console.log("PASS inventory economics repository binds repeat requests and exposes purchased postage cents");
} finally {
  await getPool().end();
}
