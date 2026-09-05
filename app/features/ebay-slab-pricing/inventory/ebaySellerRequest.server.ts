import { XMLParser, XMLValidator } from "fast-xml-parser";
import { SlabInventoryError } from "./slabInventory";

export type SellerRead = "GetUser" | "GetMyeBaySelling" | "GetItem";
export type SellerXml = Record<string, any>;
export type SellerRequest = (
  call: SellerRead,
  fields: string,
  signal?: AbortSignal,
) => Promise<SellerXml>;
const unavailable = () =>
  new SlabInventoryError(
    "unavailable",
    "eBay seller access is unavailable. Check production OAuth configuration and reconnect if needed.",
  );
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) =>
    [
      "Item",
      "Variation",
      "NameValueList",
      "Value",
      "Errors",
      "ShippingServiceOptions",
    ].includes(name),
});

export function parseSellerXml(xml: string, call: SellerRead): SellerXml {
  try {
    if (
      Buffer.byteLength(xml) > 2 * 1024 * 1024 ||
      /<!DOCTYPE|<!ENTITY/i.test(xml) ||
      XMLValidator.validate(xml) !== true
    )
      throw unavailable();
    const result = parser.parse(xml)[`${call}Response`];
    if (
      !result ||
      result["@_xmlns"] !== "urn:ebay:apis:eBLBaseComponents" ||
      result.Ack !== "Success" ||
      result.Errors?.length
    )
      throw unavailable();
    // Warning responses may be partial or omit requested data. Never grant completeness to them.
    return result;
  } catch {
    throw unavailable();
  }
}

async function boundedText(response: Response) {
  if (!response.ok || !response.body) throw unavailable();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let length = 0,
    text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      length += value.byteLength;
      if (length > 2 * 1024 * 1024) throw unavailable();
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function sellerOAuthConfigured() {
  return [
    process.env.EBAY_SELLER_CLIENT_ID,
    process.env.EBAY_SELLER_CLIENT_SECRET,
    process.env.EBAY_SELLER_REFRESH_TOKEN,
  ].every((value) => !!value?.trim());
}

// One token exchange per import, no global token cache or general marketplace client.
export function createSellerRequestForRun(
  fetcher: typeof fetch = fetch,
): SellerRequest {
  let token: Promise<string> | undefined;
  let count = 0;
  return async (call, fields, signal) => {
    if (
      !["GetUser", "GetMyeBaySelling", "GetItem"].includes(call) ||
      ++count > 30
    )
      throw unavailable();
    const timeout = AbortSignal.timeout(25_000);
    const boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      if (!token)
        token = (async () => {
          if (!sellerOAuthConfigured()) throw unavailable();
          const authorization = Buffer.from(
            `${process.env.EBAY_SELLER_CLIENT_ID}:${process.env.EBAY_SELLER_CLIENT_SECRET}`,
          ).toString("base64");
          const response = await fetcher(
            "https://api.ebay.com/identity/v1/oauth2/token",
            {
              method: "POST",
              redirect: "manual",
              signal: boundedSignal,
              headers: {
                Authorization: `Basic ${authorization}`,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: process.env.EBAY_SELLER_REFRESH_TOKEN!,
                scope: "https://api.ebay.com/oauth/api_scope",
              }).toString(),
            },
          );
          const value = JSON.parse(await boundedText(response));
          if (
            typeof value.access_token !== "string" ||
            !value.access_token ||
            value.access_token.length > 16384
          )
            throw unavailable();
          return value.access_token as string;
        })();
      const accessToken = await token;
      const response = await fetcher("https://api.ebay.com/ws/api.dll", {
        method: "POST",
        redirect: "manual",
        signal: boundedSignal,
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          "X-EBAY-API-CALL-NAME": call,
          "X-EBAY-API-SITEID": "0",
          "X-EBAY-API-COMPATIBILITY-LEVEL": "1477",
          "X-EBAY-API-IAF-TOKEN": accessToken,
        },
        body: `<?xml version="1.0" encoding="utf-8"?><${call}Request xmlns="urn:ebay:apis:eBLBaseComponents">${fields}</${call}Request>`,
      });
      return parseSellerXml(await boundedText(response), call);
    } catch {
      throw unavailable();
    }
  };
}
