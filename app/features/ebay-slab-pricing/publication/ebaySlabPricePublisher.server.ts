import { createHash } from "node:crypto";
import { sellerAccount } from "../inventory/slabInventory";
import { sellerItemSnapshots } from "../inventory/ebaySellerInventoryProvider.server";
import type {
  SellerRequest,
  SellerXml,
} from "../inventory/ebaySellerRequest.server";
import {
  listingState,
  SlabPublisherError,
  type SlabPricePublisher,
  type SellerListingState,
} from "./slabPublication";
const unavailable = () => new SlabPublisherError("unavailable");
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, entry]) => [key, canonical(entry)]),
        )
      : value;

export function protectedSellerListing(item: SellerXml) {
  // Retain all returned listing configuration, including descriptions and business/offer policies.
  // Counters, seller reputation and derived current-price fields are not listing configuration.
  const {
    StartPrice,
    SellingStatus,
    Seller,
    HitCount,
    WatchCount,
    ListingDetails,
    ...fields
  } = item;
  const { ConvertedStartPrice, ...details } = ListingDetails ?? {};
  return createHash("sha256")
    .update(JSON.stringify(canonical({ ...fields, ListingDetails: details })))
    .digest("hex");
}
export function createEbaySlabPricePublisher(requests: {
  read: SellerRequest;
  reviseInventoryStatus: (
    fields: string,
    signal?: AbortSignal,
  ) => Promise<SellerXml>;
}): SlabPricePublisher {
  let checked: SellerListingState | null = null;
  return {
    id: "ebay-trading-price-v1",
    kind: "seller-api",
    async read(target, signal) {
      checked = null;
      const seller = sellerAccount(target.seller);
      if (!/^\d{9,20}$/.test(target.itemId) || target.variationKey)
        throw new SlabPublisherError("unsupported");
      signal.throwIfAborted();
      const user = await requests.read(
        "GetUser",
        "<OutputSelector>User.UserID</OutputSelector>",
        signal,
      );
      const accountSeller = sellerAccount(user.User?.UserID);
      if (accountSeller !== seller) throw unavailable();
      const response = await requests.read(
        "GetItem",
        `<ItemID>${target.itemId}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics>`,
        signal,
      );
      const items = response.Item;
      if (
        !Array.isArray(items) ||
        items.length !== 1 ||
        items[0].ItemID !== target.itemId ||
        sellerAccount(items[0].Seller?.UserID) !== seller
      )
        throw unavailable();
      const item = items[0],
        snapshots = sellerItemSnapshots(item);
      if (snapshots.length !== 1) throw new SlabPublisherError("unsupported");
      const row = snapshots[0];
      // Inventory API listings require a SKU. Until origin can be independently verified,
      // hold every SKU-managed listing, including otherwise compatible Trading listings.
      const supported =
        !item.Variations &&
        !item.SKU &&
        (!item.InventoryTrackingMethod ||
          item.InventoryTrackingMethod === "ItemID") &&
        item.Site === "US" &&
        row.format === "fixed-price" &&
        row.price.currency === "USD";
      signal.throwIfAborted();
      checked = listingState({
        ...target,
        seller,
        accountSeller,
        price: row.price,
        quantity: row.quantity,
        state: row.state,
        format: row.format,
        certificate: row.certificate,
        title: row.title,
        shipping: row.shipping,
        protectedRevision: protectedSellerListing(item),
        observedAt: new Date().toISOString(),
        supported,
      });
      return listingState(checked);
    },
    async write(input, signal) {
      const before = checked;
      checked = null; // A read authorizes at most one dispatch through this run's adapter.
      if (
        !before ||
        !before.supported ||
        before.state !== "active" ||
        before.quantity !== 1 ||
        before.seller !== input.seller ||
        before.itemId !== input.itemId ||
        before.variationKey !== input.variationKey ||
        Date.now() < Date.parse(before.observedAt) ||
        Date.now() - Date.parse(before.observedAt) > 60_000 ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          input.intentId,
        ) ||
        input.price?.currency !== "USD" ||
        !Number.isFinite(input.price.amount) ||
        input.price.amount <= 0 ||
        input.price.amount >= 1e9 ||
        Math.abs(
          input.price.amount * 100 - Math.round(input.price.amount * 100),
        ) > 1e-6 ||
        signal.aborted
      )
        return "rejected";
      try {
        const response = await requests.reviseInventoryStatus(
          `<InventoryStatus><ItemID>${input.itemId}</ItemID><StartPrice currencyID="USD">${input.price.amount.toFixed(2)}</StartPrice></InventoryStatus><MessageID>${input.intentId}</MessageID>`,
          signal,
        );
        return response.Ack === "Success" &&
          !response.Errors?.length &&
          response.CorrelationID === input.intentId &&
          response.InventoryStatus?.length === 1 &&
          response.InventoryStatus[0].ItemID === input.itemId
          ? "accepted"
          : "unknown";
      } catch {
        // Transport/parser/auth errors after dispatch cannot prove no change occurred.
        return "unknown";
      }
    },
  };
}
