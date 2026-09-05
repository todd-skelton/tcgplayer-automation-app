import { createHash } from "node:crypto";
import {
  parseInventoryImport,
  parseListingSnapshot,
  sellerAccount,
  SlabInventoryError,
  type InventoryImport,
  type ListingSnapshot,
} from "./slabInventory";
import type { SellerRequest, SellerXml } from "./ebaySellerRequest.server";

const invalid = () =>
  new SlabInventoryError(
    "unavailable",
    "eBay returned incomplete or inconsistent seller inventory. No listings were reconciled.",
  );
function integer(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw invalid();
  return Number(value);
}
function money(value: any) {
  if (
    !value ||
    typeof value["#text"] !== "string" ||
    !/^\d+(?:\.\d+)?$/.test(value["#text"]) ||
    !/^[A-Z]{3}$/.test(value["@_currencyID"])
  )
    throw invalid();
  return {
    amount: Number(value["#text"]),
    currency: value["@_currencyID"] as string,
  };
}
function specifics(value: any): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const pair of value?.NameValueList ?? []) {
    if (
      typeof pair.Name !== "string" ||
      !Array.isArray(pair.Value) ||
      pair.Value.some((value: unknown) => typeof value !== "string") ||
      Object.hasOwn(result, pair.Name)
    )
      throw invalid();
    result[pair.Name] = pair.Value;
  }
  return result;
}
function certificateFrom(fields: Record<string, string[]>) {
  if (
    fields["Professional Grader"]?.length !== 1 ||
    fields["Certification Number"]?.length !== 1
  )
    return null;
  const raw = fields["Professional Grader"]?.[0];
  const grader =
    (
      {
        "Professional Sports Authenticator (PSA)": "PSA",
        "Certified Guaranty Company (CGC)": "CGC",
        "Beckett Grading Services (BGS)": "BGS",
      } as Record<string, string>
    )[raw ?? ""] ?? raw;
  const certificateNumber = fields["Certification Number"]?.[0];
  return grader &&
    ["PSA", "CGC", "BGS", "SGC"].includes(grader) &&
    certificateNumber &&
    /^[a-zA-Z0-9-]{1,80}$/.test(certificateNumber)
    ? { grader, certificateNumber }
    : null;
}

export function sellerItemSnapshots(
  item: SellerXml,
  activeSummary = false,
): ListingSnapshot[] {
  const itemFields = specifics(item.ItemSpecifics);
  const variations = item.Variations?.Variation;
  if (
    variations !== undefined &&
    (!Array.isArray(variations) || !variations.length)
  )
    throw invalid();
  return (variations ?? [null]).map((variation: SellerXml | null) => {
    const variationFields = specifics(variation?.VariationSpecifics);
    const fields = { ...itemFields, ...variationFields };
    const variationKey = variation
      ? createHash("sha256")
          .update(
            JSON.stringify(
              Object.entries(variationFields)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([key, values]) => [key, [...values].sort()]),
            ),
          )
          .digest("hex")
      : "";
    if (variation && !Object.keys(variationFields).length) throw invalid();
    const quantity = variation
      ? integer(variation.Quantity) -
        integer(variation.SellingStatus?.QuantitySold)
      : item.QuantityAvailable !== undefined
        ? integer(item.QuantityAvailable)
        : integer(item.Quantity) - integer(item.SellingStatus?.QuantitySold);
    const price = money(
      variation?.StartPrice ?? item.SellingStatus?.CurrentPrice,
    );
    const rawState = item.SellingStatus?.ListingStatus;
    if (!activeSummary && !["Active", "Completed", "Ended"].includes(rawState))
      throw invalid();
    if (activeSummary && rawState !== undefined && rawState !== "Active")
      throw invalid();
    const state =
      rawState === "Completed" || rawState === "Ended"
        ? quantity === 0 &&
          integer(
            variation?.SellingStatus?.QuantitySold ??
              item.SellingStatus?.QuantitySold,
          ) > 0
          ? "sold"
          : "ended"
        : "active";
    const shippingOption = item.ShippingDetails?.ShippingServiceOptions?.find(
      (value: any) => value.ShippingServicePriority === "1",
    );
    const shippingPrice = shippingOption?.ShippingServiceCost
      ? money(shippingOption.ShippingServiceCost)
      : null;
    const grade = fields.Grade?.[0];
    const gradeNumber =
      grade && /^\d+(?:\.5)?$/.test(grade) ? Number(grade) : null;
    return parseListingSnapshot({
      itemId: item.ItemID,
      variationKey,
      sku: variation?.SKU ?? item.SKU ?? null,
      title: item.Title,
      price,
      quantity,
      state,
      format:
        item.ListingType === "FixedPriceItem" ||
        item.ListingType === "StoreInventory"
          ? "fixed-price"
          : item.ListingType === "Chinese"
            ? "auction"
            : "unknown",
      shipping: {
        amount: shippingPrice?.amount ?? null,
        currency: shippingPrice?.currency ?? null,
        policyId:
          item.SellerProfiles?.SellerShippingProfile?.ShippingProfileID ?? null,
      },
      certificate: certificateFrom(fields),
      specifics: fields,
      expected: {
        name: fields["Card Name"]?.[0],
        game: fields.Game?.[0],
        language: fields.Language?.[0],
        set: fields.Set?.[0],
        cardNumber: fields["Card Number"]?.[0],
        year: fields["Year Manufactured"]?.[0],
        finish: fields.Finish?.[0],
        gradeNumber,
        gradeLabel: gradeNumber === null ? grade : null,
      },
      reviewReasons: [
        ...(item.ItemSpecifics ? [] : ["listing-details-required"]),
        ...(Object.values(fields).some((values) => values.length > 1)
          ? ["multiple-specific-values-require-review"]
          : []),
        ...(variations &&
        fields["Certification Number"] &&
        !variationFields["Certification Number"]
          ? ["variation-certificate-required"]
          : []),
      ],
    });
  });
}

export function createSellerInventoryProvider(request: SellerRequest) {
  return {
    async importActive(
      seller: string,
      options: { maxPages?: number; signal?: AbortSignal } = {},
    ): Promise<InventoryImport> {
      seller = sellerAccount(seller);
      const maxPages = options.maxPages ?? 20;
      if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20)
        throw invalid();
      const observedAt = new Date().toISOString();
      const user = await request(
        "GetUser",
        "<OutputSelector>User.UserID</OutputSelector>",
        options.signal,
      );
      if (sellerAccount(user.User?.UserID) !== seller)
        throw new SlabInventoryError(
          "conflict",
          "The authorized eBay account does not match this seller.",
        );
      const listings: ListingSnapshot[] = [];
      let total = -1,
        pages = -1,
        complete = false;
      for (let page = 1; page <= maxPages; page++) {
        const response = await request(
          "GetMyeBaySelling",
          `<ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList><SoldList><Include>false</Include></SoldList><UnsoldList><Include>false</Include></UnsoldList><ScheduledList><Include>false</Include></ScheduledList><HideVariations>false</HideVariations>`,
          options.signal,
        );
        const active = response.ActiveList;
        if (!active) throw invalid();
        const count = integer(active.PaginationResult?.TotalNumberOfEntries);
        const pageCount = integer(active.PaginationResult?.TotalNumberOfPages);
        if (page === 1) {
          total = count;
          pages = pageCount;
        }
        if (
          total !== count ||
          pages !== pageCount ||
          pages !== Math.ceil(total / 200)
        )
          throw invalid();
        const items = active.ItemArray?.Item ?? [];
        if (
          !Array.isArray(items) ||
          items.length !== Math.min(200, Math.max(0, total - (page - 1) * 200))
        )
          throw invalid();
        for (const item of items)
          listings.push(...sellerItemSnapshots(item, true));
        if (listings.length > 5000) throw invalid();
        if (page >= pages) {
          complete = true;
          break;
        }
      }
      return parseInventoryImport({
        seller,
        source: "ebay",
        observedAt,
        completeActiveInventory: complete,
        listings,
      });
    },
    async getListing(seller: string, itemId: string, signal?: AbortSignal) {
      seller = sellerAccount(seller);
      if (!/^\d{9,20}$/.test(itemId)) throw invalid();
      const response = await request(
        "GetItem",
        `<ItemID>${itemId}</ItemID><IncludeItemSpecifics>true</IncludeItemSpecifics>` +
          [
            "ItemID",
            "Title",
            "SKU",
            "ListingType",
            "Quantity",
            "SellingStatus.CurrentPrice",
            "SellingStatus.QuantitySold",
            "SellingStatus.ListingStatus",
            "ItemSpecifics",
            "Variations",
            "Seller.UserID",
            "SellerProfiles.SellerShippingProfile",
            "ShippingDetails.ShippingServiceOptions",
          ]
            .map((field) => `<OutputSelector>Item.${field}</OutputSelector>`)
            .join(""),
        signal,
      );
      const items = response.Item;
      if (
        !Array.isArray(items) ||
        items.length !== 1 ||
        items[0].ItemID !== itemId ||
        sellerAccount(items[0].Seller?.UserID) !== seller
      )
        throw invalid();
      return parseInventoryImport({
        seller,
        source: "ebay",
        observedAt: new Date().toISOString(),
        completeActiveInventory: false,
        listings: sellerItemSnapshots(items[0]),
      });
    },
  };
}
