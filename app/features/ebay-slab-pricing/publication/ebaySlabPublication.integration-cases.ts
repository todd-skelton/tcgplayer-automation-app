import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { SlabPublicationPreview } from "./slabPublicationPreviews.server";
import { action, loader } from "../routes/api.slab-publications.server";
import {
  listingPublicationHistory,
  getPublication,
} from "./slabPublicationStore.server";
export async function verifyNativePublication(
  preview: SlabPublicationPreview,
  db: pg.Pool,
) {
  const envNames = [
    "EBAY_SELLER_CLIENT_ID",
    "EBAY_SELLER_CLIENT_SECRET",
    "EBAY_SELLER_REFRESH_TOKEN",
    "EBAY_SLAB_PUBLISHING_ENABLED",
  ];
  const previousEnv = envNames.map((name) => process.env[name]),
    previousFetch = globalThis.fetch;
  const ids: string[] = [],
    p = preview.plan,
    item = p.inventory.snapshot;
  let price = p.oldPrice.amount,
    writes = 0,
    lost = false,
    failedReadback = false;
  const esc = (value: unknown) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const post = async (body: unknown) =>
    action({
      request: new Request("http://localhost/api/slab-publications", {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    });
  try {
    for (const name of envNames.slice(0, 3)) process.env[name] = "synthetic";
    process.env.EBAY_SLAB_PUBLISHING_ENABLED = "false";
    globalThis.fetch = async (url, options) => {
      if (url === "https://api.ebay.com/identity/v1/oauth2/token")
        return new Response(
          JSON.stringify({ access_token: "synthetic-access-token" }),
        );
      assert.equal(url, "https://api.ebay.com/ws/api.dll");
      const headers = new Headers(options?.headers),
        call = headers.get("X-EBAY-API-CALL-NAME"),
        body = String(options?.body);
      assert.equal(
        headers.get("X-EBAY-API-IAF-TOKEN"),
        "synthetic-access-token",
      );
      let payload = "";
      if (call === "GetUser")
        payload = `<User><UserID>${esc(p.inventory.seller)}</UserID></User>`;
      else if (call === "GetItem") {
        if (failedReadback) throw new Error("Synthetic readback outage");
        payload = `<Item><ItemID>${p.inventory.itemId}</ItemID><Title>${esc(item.title)}</Title><Description>Synthetic publication fixture</Description><Site>US</Site><Quantity>1</Quantity><ListingType>FixedPriceItem</ListingType><Seller><UserID>${esc(p.inventory.seller)}</UserID></Seller><StartPrice currencyID="USD">${price}</StartPrice><SellingStatus><CurrentPrice currencyID="USD">${price}</CurrentPrice><QuantitySold>0</QuantitySold><ListingStatus>Active</ListingStatus></SellingStatus><ItemSpecifics><NameValueList><Name>Professional Grader</Name><Value>${esc(item.certificate!.grader)}</Value></NameValueList><NameValueList><Name>Certification Number</Name><Value>${esc(item.certificate!.certificateNumber)}</Value></NameValueList></ItemSpecifics>${item.shipping.amount === null ? "" : `<ShippingDetails><ShippingServiceOptions><ShippingServicePriority>1</ShippingServicePriority><ShippingServiceCost currencyID="USD">${item.shipping.amount}</ShippingServiceCost></ShippingServiceOptions></ShippingDetails>`}${item.shipping.policyId ? `<SellerProfiles><SellerShippingProfile><ShippingProfileID>${esc(item.shipping.policyId)}</ShippingProfileID></SellerShippingProfile></SellerProfiles>` : ""}</Item>`;
      } else {
        assert.equal(call, "ReviseInventoryStatus");
        assert.ok(
          !/<(?:Quantity|Title|SKU|ShippingDetails|BestOfferDetails)>/.test(
            body,
          ),
        );
        assert.ok(body.includes(`<ItemID>${p.inventory.itemId}</ItemID>`));
        const selected =
            /<StartPrice currencyID="USD">([\d.]+)<\/StartPrice>/.exec(body),
          correlation = /<MessageID>([a-f0-9-]+)<\/MessageID>/.exec(body);
        assert.ok(selected && correlation);
        price = Number(selected[1]);
        writes++;
        if (lost) {
          failedReadback = true;
          throw new Error("Synthetic lost acknowledgement");
        }
        payload = `<CorrelationID>${correlation[1]}</CorrelationID><InventoryStatus><ItemID>${p.inventory.itemId}</ItemID></InventoryStatus>`;
      }
      return new Response(
        `<${call}Response xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack>${payload}</${call}Response>`,
      );
    };
    const first = randomUUID();
    ids.push(first);
    assert.equal(
      (
        await post({
          intent: "prepare-live",
          intentId: first,
          previewId: preview.id,
        })
      ).init?.status,
      200,
    );
    assert.equal((await getPublication(first))!.state, "prepared");
    assert.equal(writes, 0);
    assert.equal(
      (await post({ intent: "approve", id: first, confirmation: first })).init
        ?.status,
      503,
    );
    process.env.EBAY_SLAB_PUBLISHING_ENABLED = "true";
    assert.equal(
      (await post({ intent: "approve", id: first })).init?.status,
      400,
    );
    const approved = await post({
      intent: "approve",
      id: first,
      confirmation: first,
    });
    assert.equal(approved.init?.status, 200);
    assert.equal((await getPublication(first))!.state, "confirmed");
    assert.equal(writes, 1);
    await post({ intent: "approve", id: first, confirmation: first });
    assert.equal(writes, 1, "Confirmed API retry does not resend");
    price = p.oldPrice.amount;
    const second = randomUUID();
    ids.push(second);
    assert.equal(
      (
        await post({
          intent: "prepare-live",
          intentId: second,
          previewId: preview.id,
        })
      ).init?.status,
      200,
    );
    lost = true;
    assert.equal(
      (await post({ intent: "approve", id: second, confirmation: second })).init
        ?.status,
      200,
    );
    assert.equal((await getPublication(second))!.state, "reconcile");
    assert.equal(writes, 2);
    process.env.EBAY_SLAB_PUBLISHING_ENABLED = "false";
    assert.equal(
      (await post({ intent: "cancel", id: second })).init?.status,
      200,
    );
    assert.equal(
      (await getPublication(second))!.state,
      "reconcile",
      "An uncertain write cannot be cancelled",
    );
    for (let n = 0; n < 26; n++) {
      const id = randomUUID();
      ids.push(id);
      await db.query(
        "INSERT INTO slab_publications(id,preview_id,seller,item_id,variation_key,mode,plan,state) SELECT $1,preview_id,seller,item_id,variation_key,mode,plan,'prepared' FROM slab_publications WHERE id=$2",
        [id, second],
      );
    }
    const history = await listingPublicationHistory(p.inventory.id);
    assert.equal(history.length, 25);
    assert.equal(
      history[0].id,
      second,
      "Unresolved intents stay visible beyond recent-history bounds",
    );
    const listing = await loader({
      request: new Request(
        `http://localhost/api/slab-publications?inventoryId=${p.inventory.id}`,
      ),
    });
    assert.equal(listing.init?.status, 200);
    failedReadback = false;
    assert.equal(
      (await post({ intent: "reconcile", id: second })).init?.status,
      200,
    );
    assert.equal((await getPublication(second))!.state, "confirmed");
    assert.equal(
      writes,
      2,
      "Readback remains available with new writes disabled",
    );
    console.log(
      "PASS Trading publisher through HTTP: prepare-only mode, explicit approval, price-only dispatch/readback, terminal retry, lost response, paused-write reconciliation and visible unresolved history",
    );
  } finally {
    globalThis.fetch = previousFetch;
    envNames.forEach((name, index) =>
      previousEnv[index] === undefined
        ? delete process.env[name]
        : (process.env[name] = previousEnv[index]),
    );
    await db.query(
      "DELETE FROM slab_publication_events WHERE publication_id=ANY($1::uuid[])",
      [ids],
    );
    await db.query("DELETE FROM slab_publications WHERE id=ANY($1::uuid[])", [
      ids,
    ]);
  }
}
