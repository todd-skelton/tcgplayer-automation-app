import assert from "node:assert/strict";
import type {
  Listing,
  Product,
} from "../../../integrations/tcgplayer/client/get-search-results.server";
import { convertProductToListing } from "./inventoryConverter";

const product = {
  productLineName: "Pokemon",
  setName: "Celebrations",
  productName: "Greninja Star",
  marketPrice: 19.87,
} as Product;
const listing = {
  productConditionId: 5199433,
  printing: "Holofoil",
  condition: "Near Mint Holofoil",
  quantity: 4,
  price: 24.99,
} as Listing;

const converted = convertProductToListing(product, listing);

assert.equal(converted["TCG Market Price"], "19.87");
assert.equal(converted["TCG Marketplace Price"], "24.99");
assert.equal(converted["Total Quantity"], "4");

console.log("PASS seller inventory conversion preserves market price");
