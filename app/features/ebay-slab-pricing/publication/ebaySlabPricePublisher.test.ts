import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  parseSellerXml,
  createSellerRequestForRun,
} from "../inventory/ebaySellerRequest.server";
import {
  createEbaySlabPricePublisher,
  protectedSellerListing,
} from "./ebaySlabPricePublisher.server";
const item = {
  ItemID: "900000000001",
  Title: "Synthetic PSA slab",
  Site: "US",
  Quantity: "1",
  ListingType: "FixedPriceItem",
  StartPrice: { "#text": "100.00", "@_currencyID": "USD" },
  Seller: { UserID: "pokebash", FeedbackScore: "10" },
  SellingStatus: {
    CurrentPrice: { "#text": "100.00", "@_currencyID": "USD" },
    QuantitySold: "0",
    ListingStatus: "Active",
  },
  ItemSpecifics: {
    NameValueList: [
      { Name: "Professional Grader", Value: ["PSA"] },
      { Name: "Certification Number", Value: ["00123456"] },
    ],
  },
  ListingDetails: {
    StartTime: "2026-09-01T00:00:00Z",
    BestOfferAutoAcceptPrice: { "#text": "150", "@_currencyID": "USD" },
  },
  ShippingDetails: {
    ShippingServiceOptions: [
      {
        ShippingServicePriority: "1",
        ShippingServiceCost: { "#text": "0", "@_currencyID": "USD" },
      },
    ],
  },
  Description: "Synthetic fixture description",
  ReturnPolicy: { ReturnsAcceptedOption: "ReturnsAccepted" },
  HitCount: "10",
};
const target = { seller: "pokebash", itemId: item.ItemID, variationKey: "" },
  signal = new AbortController().signal;
const input = {
  ...target,
  intentId: randomUUID(),
  price: { amount: 125, currency: "USD" },
};
let readItem = structuredClone(item),
  owner = "pokebash",
  writes: string[] = [];
let response: any = {
  Ack: "Success",
  CorrelationID: input.intentId,
  InventoryStatus: [{ ItemID: item.ItemID }],
};
const provider = () =>
  createEbaySlabPricePublisher({
    read: async (call, fields) => {
      if (call === "GetUser") return { User: { UserID: owner } };
      assert.ok(fields.includes("<DetailLevel>ReturnAll</DetailLevel>"));
      return { Item: [structuredClone(readItem)] };
    },
    reviseInventoryStatus: async (fields) => {
      writes.push(fields);
      if (response instanceof Error) throw response;
      return response;
    },
  });
const p = provider();
assert.equal(await p.write(input, signal), "rejected");
const before = await p.read(target, signal);
assert.equal(before.supported, true);
assert.equal(before.certificate?.certificateNumber, "00123456");
assert.equal(await p.write(input, signal), "accepted");
assert.equal(writes.length, 1);
assert.equal(
  writes[0],
  `<InventoryStatus><ItemID>${item.ItemID}</ItemID><StartPrice currencyID="USD">125.00</StartPrice></InventoryStatus><MessageID>${input.intentId}</MessageID>`,
);
assert.equal(
  await p.write(input, signal),
  "rejected",
  "A read cannot dispatch twice",
);
const changedPrice = structuredClone(item);
changedPrice.StartPrice["#text"] = "125.00";
changedPrice.SellingStatus.CurrentPrice["#text"] = "125.00";
changedPrice.Seller.FeedbackScore = "11";
changedPrice.HitCount = "11";
assert.equal(
  protectedSellerListing(item),
  protectedSellerListing(changedPrice),
);
assert.equal(
  protectedSellerListing(item),
  protectedSellerListing(Object.fromEntries(Object.entries(item).reverse())),
);
for (const changed of [
  { ...item, Description: "Changed description" },
  { ...item, Title: "Another slab" },
  { ...item, ReturnPolicy: { ReturnsAcceptedOption: "ReturnsNotAccepted" } },
  {
    ...item,
    ListingDetails: {
      ...item.ListingDetails,
      BestOfferAutoAcceptPrice: { "#text": "120", "@_currencyID": "USD" },
    },
  },
  {
    ...item,
    SellerProfiles: { SellerShippingProfile: { ShippingProfileID: "changed" } },
  },
])
  assert.notEqual(
    protectedSellerListing(item),
    protectedSellerListing(changed),
  );
for (const change of [
  { SKU: "even-a-trading-sku" },
  { InventoryTrackingMethod: "SKU" },
  { Site: "UK" },
]) {
  readItem = { ...structuredClone(item), ...change };
  const blocked = provider();
  const observation = await blocked.read(target, signal);
  assert.equal(observation.supported, false);
  observation.supported = true;
  assert.equal(
    await blocked.write(input, signal),
    "rejected",
    "Mutating returned observations cannot bypass adapter gates",
  );
}
readItem = structuredClone(item);
owner = "wrong-account";
await assert.rejects(() => provider().read(target, signal));
owner = "pokebash";
await assert.rejects(() =>
  provider().read({ ...target, variationKey: "variation" }, signal),
);
for (const failed of [
  { ...response, CorrelationID: "wrong" },
  { ...response, Ack: "Warning" },
  { ...response, InventoryStatus: [{ ItemID: "900000000002" }] },
  new Error("lost response"),
]) {
  response = failed;
  const uncertain = provider();
  await uncertain.read(target, signal);
  assert.equal(await uncertain.write(input, signal), "unknown");
}
const parsed = parseSellerXml(
  `<ReviseInventoryStatusResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><CorrelationID>${input.intentId}</CorrelationID><InventoryStatus><ItemID>${item.ItemID}</ItemID></InventoryStatus></ReviseInventoryStatusResponse>`,
  "ReviseInventoryStatus",
);
assert.equal(parsed.InventoryStatus.length, 1);
let remote = 0;
const readOnly = createSellerRequestForRun(async () => {
  remote++;
  throw new Error("No write capability");
});
await assert.rejects(async () =>
  readOnly("ReviseInventoryStatus" as any, "", signal),
);
assert.equal(remote, 0, "Inventory readers cannot invoke a price mutation");
console.log(
  "PASS narrow Trading publisher: authenticated owner, no-SKU capability gate, protected fields, exact price-only XML, one dispatch, response correlation and ambiguous failures",
);
