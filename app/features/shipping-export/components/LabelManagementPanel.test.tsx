import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { LabelManagementPanel } from "./LabelManagementPanel";
import { mapOrderToShipment } from "../services/shippingExportUtils";
import {
  DEFAULT_SHIPPING_EXPORT_CONFIG,
  type ShippingPostagePurchaseEntry,
  type TcgPlayerShippingOrder,
} from "../types/shippingExport";

const order: TcgPlayerShippingOrder = {
  "Order #": "1001",
  FirstName: "Jane",
  LastName: "Doe",
  Address1: "123 Wrong St",
  Address2: "",
  City: "Dallas",
  State: "TX",
  PostalCode: "75001",
  Country: "US",
  "Order Date": "2026-10-20",
  "Product Weight": 0,
  "Shipping Method": "Standard",
  "Item Count": 3,
  "Value Of Products": 10,
  "Shipping Fee Paid": 1.27,
  "Tracking #": "",
  Carrier: "",
};
const orderShipment = mapOrderToShipment(order, DEFAULT_SHIPPING_EXPORT_CONFIG);
const correctedShipment = {
  ...orderShipment,
  to_address: { ...orderShipment.to_address, street1: "456 Corrected Ave" },
};
const purchasedOutbound: ShippingPostagePurchaseEntry = {
  mode: "production",
  result: { reference: "1001", orderNumbers: ["1001"], status: "purchased", trackingCode: "TRACK-OLD" },
};

const visibleText = (html: string) =>
  html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const render = (props: Partial<React.ComponentProps<typeof LabelManagementPanel>> = {}) =>
  renderToStaticMarkup(
    <LabelManagementPanel
      config={DEFAULT_SHIPPING_EXPORT_CONFIG}
      environmentStatus={{ hasTestApiKey: true, hasProductionApiKey: true }}
      sellerKeyInput="seller"
      orderNumberInput="1001"
      order={order}
      shipment={correctedShipment}
      purchaseType="outbound-only"
      outboundEntry={purchasedOutbound}
      returnEntry={null}
      isLoadingOrder={false}
      isLoadingLabels={false}
      isPurchasing={false}
      onOrderNumberChange={() => {}}
      onLookupOrder={() => {}}
      onPurchaseTypeChange={() => {}}
      onShipmentChange={() => {}}
      onServiceChange={() => {}}
      onResetShipment={() => {}}
      onBuyLabels={() => {}}
      {...props}
    />,
  );

const replacement = render();
assert.match(replacement, /value="456 Corrected Ave"/, "the buyer address is editable and shows the edited street");
assert.match(visibleText(replacement), /Outbound only/);
assert.match(visibleText(replacement), /Buy Another Outbound Label/);
assert.match(
  visibleText(replacement),
  /An outbound label was already purchased for this order\..*refund the old one in EasyPost/,
  "replacing an outbound label warns about the charge and the old label",
);

const returnOnly = visibleText(render({ purchaseType: "return-only" }));
assert.match(returnOnly, /Buy Return Label/);
assert.doesNotMatch(returnOnly, /already purchased/, "a return label is not a repurchase when only outbound was bought");

const roundTrip = visibleText(render({ purchaseType: "round-trip", outboundEntry: null }));
assert.match(roundTrip, /Buy Outbound \+ Return Labels/);

console.log("PASS label management offers outbound-only labels for an edited shipment and warns on replacement");
