import assert from "node:assert/strict";
import {
  createSellerInventoryProvider,
  sellerItemSnapshots,
} from "./ebaySellerInventoryProvider.server";
import {
  createSellerRequestForRun,
  parseSellerXml,
  type SellerRead,
} from "./ebaySellerRequest.server";

// Contract examples derived from Trading API schemas; production proof awaits key activation.
const wrap = (call: SellerRead, body: string, ack = "Success") =>
  `<${call}Response xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>${ack}</Ack>${body}</${call}Response>`;
const item = (id = "397774081597") =>
  `<Item><ItemID>${id}</ItemID><Title>Zapdos &amp; friends</Title><SKU>duplicate</SKU><Quantity>2</Quantity><QuantityAvailable>1</QuantityAvailable><ListingType>FixedPriceItem</ListingType><Seller><UserID>pokebash</UserID></Seller><SellingStatus><CurrentPrice currencyID="USD">16.00</CurrentPrice><QuantitySold>1</QuantitySold><ListingStatus>Active</ListingStatus></SellingStatus><ItemSpecifics><NameValueList><Name>Professional Grader</Name><Value>Professional Sports Authenticator (PSA)</Value></NameValueList><NameValueList><Name>Certification Number</Name><Value>00123456</Value></NameValueList><NameValueList><Name>Grade</Name><Value>8</Value></NameValueList></ItemSpecifics></Item>`;
const active = (items: string, total: number) =>
  parseSellerXml(
    wrap(
      "GetMyeBaySelling",
      `<ActiveList><ItemArray>${items}</ItemArray><PaginationResult><TotalNumberOfEntries>${total}</TotalNumberOfEntries><TotalNumberOfPages>${Math.ceil(total / 200)}</TotalNumberOfPages></PaginationResult></ActiveList>`,
    ),
    "GetMyeBaySelling",
  );
const user = parseSellerXml(
  wrap("GetUser", "<User><UserID>pokebash</UserID></User>"),
  "GetUser",
);
const detail = parseSellerXml(wrap("GetItem", item()), "GetItem");
const row = sellerItemSnapshots(detail.Item[0])[0];
assert.equal(row.title, "Zapdos & friends");
assert.equal(row.quantity, 1);
assert.equal(row.certificate?.certificateNumber, "00123456");
assert.equal(row.shipping.amount, null);
assert.equal(row.expected.gradeNumber, 8);
assert.throws(() => parseSellerXml(wrap("GetUser", "", "Warning"), "GetUser"));
assert.throws(() =>
  parseSellerXml(wrap("GetUser", "").slice(0, -8), "GetUser"),
);
assert.throws(() =>
  parseSellerXml(
    `<!DOCTYPE data [<!ENTITY x "test">]>${wrap("GetUser", "")}`,
    "GetUser",
  ),
);
assert.throws(() =>
  parseSellerXml(
    wrap("GetUser", "").replace("urn:ebay:apis:eBLBaseComponents", "other"),
    "GetUser",
  ),
);
const calls: string[] = [];
const provider = createSellerInventoryProvider(async (call, fields) => {
  calls.push(call);
  return call === "GetUser"
    ? user
    : call === "GetItem"
      ? detail
      : active(item() + item("397774081600"), 2);
});
const result = await provider.importActive("PokeBash");
assert.equal(result.listings.length, 2);
assert.equal(result.completeActiveInventory, true);
assert.deepEqual(
  calls,
  ["GetUser", "GetMyeBaySelling"],
  "no detail calls for a sufficient summary",
);
assert.equal(
  (await provider.getListing("pokebash", "397774081597"))
    .completeActiveInventory,
  false,
);
await assert.rejects(provider.importActive("wrong-account"), /does not match/);
await assert.rejects(provider.getListing("wrong-account", "397774081597"));
await assert.rejects(provider.getListing("pokebash", "397774081600"));
const pageOne = Array.from({ length: 200 }, (_, i) =>
  item(String(397774082000 + i)),
).join("");
const paged = createSellerInventoryProvider(async (call, fields) =>
  call === "GetUser"
    ? user
    : active(
        fields.includes("<PageNumber>1</PageNumber>")
          ? pageOne
          : item("397774081600"),
        201,
      ),
);
assert.equal((await paged.importActive("pokebash")).listings.length, 201);
assert.equal(
  (await paged.importActive("pokebash", { maxPages: 1 }))
    .completeActiveInventory,
  false,
);
const truncated = createSellerInventoryProvider(async (call) =>
  call === "GetUser" ? user : active(item(), 2),
);
await assert.rejects(truncated.importActive("pokebash"));
const duplicated = createSellerInventoryProvider(async (call) =>
  call === "GetUser" ? user : active(item() + item(), 2),
);
await assert.rejects(duplicated.importActive("pokebash"));
const empty = createSellerInventoryProvider(async (call) =>
  call === "GetUser" ? user : active("", 0),
);
assert.equal(
  (await empty.importActive("pokebash")).completeActiveInventory,
  true,
);
const variant = (value: string) => ({
  SKU: "duplicate",
  Quantity: "3",
  SellingStatus: { QuantitySold: "2" },
  StartPrice: { "#text": "20", "@_currencyID": "USD" },
  VariationSpecifics: { NameValueList: [{ Name: "Card", Value: [value] }] },
});
const varied = {
  ...detail.Item[0],
  Variations: { Variation: [variant("A"), variant("B")] },
};
const variants = sellerItemSnapshots(varied);
assert.notEqual(variants[0].variationKey, variants[1].variationKey);
assert.equal(variants[0].quantity, 1);
assert.equal(variants[0].price.amount, 20);
assert.equal(
  sellerItemSnapshots({
    ...varied,
    Variations: { Variation: [...varied.Variations.Variation].reverse() },
  })[1].variationKey,
  variants[0].variationKey,
);

const previous = [
  process.env.EBAY_SELLER_CLIENT_ID,
  process.env.EBAY_SELLER_CLIENT_SECRET,
  process.env.EBAY_SELLER_REFRESH_TOKEN,
];
try {
  process.env.EBAY_SELLER_CLIENT_ID = "test-client";
  process.env.EBAY_SELLER_CLIENT_SECRET = "test-secret";
  process.env.EBAY_SELLER_REFRESH_TOKEN = "test-refresh";
  const requests: { url: string; init: RequestInit }[] = [];
  const transport = createSellerRequestForRun((async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return new Response(
      String(url).endsWith("/token")
        ? JSON.stringify({ access_token: "test-access" })
        : wrap("GetUser", "<User><UserID>pokebash</UserID></User>"),
    );
  }) as typeof fetch);
  await transport("GetUser", "");
  await transport("GetUser", "");
  assert.equal(requests.length, 3, "one refresh per run");
  assert.equal(requests[1].url, "https://api.ebay.com/ws/api.dll");
  assert.equal(
    (requests[1].init.headers as Record<string, string>)[
      "X-EBAY-API-IAF-TOKEN"
    ],
    "test-access",
  );
  assert.equal(requests[1].init.redirect, "manual");
  const forbidden = createSellerRequestForRun(
    (async () =>
      new Response("secret provider body", { status: 401 })) as typeof fetch,
  );
  await assert.rejects(
    forbidden("GetUser", ""),
    (error) =>
      error instanceof Error && !error.message.includes("secret provider body"),
  );
  await assert.rejects(transport("ReviseItem" as SellerRead, ""));
} finally {
  [
    "EBAY_SELLER_CLIENT_ID",
    "EBAY_SELLER_CLIENT_SECRET",
    "EBAY_SELLER_REFRESH_TOKEN",
  ].forEach((name, index) => {
    if (previous[index] === undefined) delete process.env[name];
    else process.env[name] = previous[index];
  });
}
