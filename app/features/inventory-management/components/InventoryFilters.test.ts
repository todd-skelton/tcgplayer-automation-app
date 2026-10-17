import assert from "node:assert/strict";
import { describeMoreFilters } from "./InventoryFilters";

assert.equal(describeMoreFilters("all", []), null);
assert.equal(describeMoreFilters("unsealed", []), "Unsealed only");
assert.equal(describeMoreFilters("sealed", ["English"]), "Sealed only, English");
assert.equal(describeMoreFilters("all", ["English", "Japanese"]), "English, Japanese");
assert.equal(describeMoreFilters("unsealed", ["English", "Japanese", "French"]), "Unsealed only, 3 languages");

console.log("PASS more filters names the hidden filters that narrow the product list");
