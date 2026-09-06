import {
  normalizeCertificate,
  normalizeExpectedIdentity,
  textField,
  type Certificate,
  type ExpectedSlabIdentity,
} from "../identity/slabIdentity";

export type ListingSnapshot = {
  itemId: string;
  variationKey: string;
  sku: string | null;
  title: string;
  price: { amount: number; currency: string };
  shipping: {
    amount: number | null;
    currency: string | null;
    policyId: string | null;
  };
  quantity: number;
  state: "active" | "ended" | "sold";
  format: "fixed-price" | "auction" | "unknown";
  certificate: Certificate | null;
  expected: ExpectedSlabIdentity;
  specifics: Record<string, string[]>;
  reviewReasons: string[];
};
export type InventoryImport = {
  seller: string;
  source: "ebay" | "csv" | "manual";
  // Only an adapter that completes an unfiltered active-list read may set this.
  completeActiveInventory: boolean;
  observedAt: string;
  listings: ListingSnapshot[];
};
export class SlabInventoryError extends Error {
  constructor(
    public readonly code: "invalid-input" | "conflict" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}
export function sellerAccount(value: unknown): string {
  const seller = textField(value, 80)?.toLowerCase();
  if (!seller || !/^[a-z0-9_.-]+$/.test(seller))
    throw new SlabInventoryError(
      "invalid-input",
      "Enter the eBay seller username.",
    );
  return seller;
}
export function listingKey(
  listing: Pick<ListingSnapshot, "itemId" | "variationKey">,
): string {
  return JSON.stringify([listing.itemId, listing.variationKey]);
}
export function parseListingSnapshot(input: ListingSnapshot): ListingSnapshot {
  const itemId = textField(input.itemId, 20);
  const title = textField(input.title, 500);
  const currency = textField(input.price?.currency, 3)?.toUpperCase();
  const amount = input.price?.amount;
  const quantity = input.quantity;
  if (
    !itemId ||
    !/^\d{9,20}$/.test(itemId) ||
    !title ||
    !currency ||
    !/^[A-Z]{3}$/.test(currency) ||
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    amount > 1e9 ||
    !Number.isSafeInteger(quantity) ||
    quantity < 0 ||
    quantity > 1e7 ||
    !["active", "ended", "sold"].includes(input.state) ||
    !["fixed-price", "auction", "unknown"].includes(input.format)
  ) {
    throw new SlabInventoryError(
      "invalid-input",
      "Each listing needs an eBay item ID, title, valid price/currency, quantity, state and format.",
    );
  }
  const shippingAmount = input.shipping?.amount ?? null;
  const shippingCurrency =
    textField(input.shipping?.currency, 3)?.toUpperCase() ?? null;
  if (
    (shippingAmount !== null &&
      (typeof shippingAmount !== "number" ||
        !Number.isFinite(shippingAmount) ||
        shippingAmount < 0 ||
        shippingAmount > 1e9)) ||
    (shippingCurrency !== null && !/^[A-Z]{3}$/.test(shippingCurrency))
  )
    throw new SlabInventoryError(
      "invalid-input",
      "Shipping must be a known amount or blank.",
    );
  const specifics: Record<string, string[]> = {};
  if (
    !input.specifics ||
    typeof input.specifics !== "object" ||
    Array.isArray(input.specifics) ||
    Object.keys(input.specifics).length > 100
  )
    throw new SlabInventoryError(
      "invalid-input",
      "Provide at most 100 item specifics.",
    );
  for (const [key, values] of Object.entries(input.specifics)) {
    const name = textField(key, 100);
    if (!name || !Array.isArray(values) || values.length > 20)
      throw new SlabInventoryError("invalid-input", "Invalid item specifics.");
    specifics[name] = values.map((value) => textField(value, 500) ?? "");
  }
  const certificate = input.certificate
    ? normalizeCertificate(input.certificate)
    : null;
  const reasons = new Set<string>();
  if (!certificate) reasons.add("certificate-required");
  if (quantity > 1) reasons.add("multiple-items-share-certificate");
  if (/\b(lot|bundle|mixed|assorted)\b/i.test(title))
    reasons.add("unsupported-lot-review-listing");
  if (input.format !== "fixed-price")
    reasons.add("fixed-price-listing-required");
  if (!Array.isArray(input.reviewReasons) || input.reviewReasons.length > 30)
    throw new SlabInventoryError(
      "invalid-input",
      "Invalid listing review reasons.",
    );
  input.reviewReasons.forEach((reason) => {
    const text = textField(reason, 100);
    if (text) reasons.add(text);
  });
  return {
    itemId,
    variationKey: textField(input.variationKey, 160) ?? "",
    sku: textField(input.sku, 200),
    title,
    price: { amount, currency },
    shipping: {
      amount: shippingAmount,
      currency: shippingCurrency,
      policyId: textField(input.shipping?.policyId, 80),
    },
    quantity,
    state: input.state,
    format: input.format,
    certificate,
    expected: normalizeExpectedIdentity(input.expected),
    specifics,
    reviewReasons: [...reasons].sort(),
  };
}
export function parseInventoryImport(input: InventoryImport): InventoryImport {
  const seller = sellerAccount(input.seller);
  if (
    !["ebay", "csv", "manual"].includes(input.source) ||
    !Array.isArray(input.listings) ||
    input.listings.length > 5000 ||
    typeof input.completeActiveInventory !== "boolean" ||
    (input.completeActiveInventory && input.source !== "ebay") ||
    typeof input.observedAt !== "string" ||
    !Number.isFinite(Date.parse(input.observedAt))
  )
    throw new SlabInventoryError(
      "invalid-input",
      "Provide a bounded, dated inventory import. CSV and manual imports are always partial.",
    );
  const keys = new Set<string>();
  const listings = input.listings.map((raw) => {
    const row = parseListingSnapshot(raw);
    const key = listingKey(row);
    if (keys.has(key))
      throw new SlabInventoryError(
        "invalid-input",
        "The import repeats a listing/variation identity.",
      );
    keys.add(key);
    return row;
  });
  return {
    ...input,
    seller,
    listings,
    observedAt: new Date(input.observedAt).toISOString(),
  };
}
