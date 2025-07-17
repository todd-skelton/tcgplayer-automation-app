/**
 * Test script to demonstrate the enhanced display name functionality for CSV exports
 */

import { createDisplayName } from "../utils/displayNameUtils";

// Test data that mimics what would come from the API
const testSkuData = [
  {
    sku: 4410185,
    productName: "Appletun",
    cardNumber: "023/192",
    rarityName: "Common",
    variant: "Reverse Holofoil",
    language: "English",
    condition: "Near Mint",
  },
  {
    sku: 4337511,
    productName: "Air Balloon",
    cardNumber: "213/202",
    rarityName: "Secret Rare",
    variant: "Holofoil",
    language: "English",
    condition: "Near Mint",
  },
  {
    sku: 4410820,
    productName: "Alcremie",
    cardNumber: "087/192",
    rarityName: "Uncommon",
    variant: "Reverse Holofoil",
    language: "Japanese",
    condition: "Near Mint",
  },
];

console.log("Testing enhanced display names for CSV export:");
console.log("=".repeat(60));

testSkuData.forEach((sku, index) => {
  const enhancedDisplayName = createDisplayName(
    sku.productName,
    sku.cardNumber,
    sku.rarityName,
    sku.variant,
    sku.language
  );

  console.log(`Test ${index + 1}:`);
  console.log(`  Original: ${sku.productName}`);
  console.log(`  Enhanced: ${enhancedDisplayName}`);
  console.log(`  Card #: ${sku.cardNumber}`);
  console.log(`  Rarity: ${sku.rarityName}`);
  console.log(`  Variant: ${sku.variant}`);
  console.log(`  Language: ${sku.language}`);
  console.log();
});

console.log("This enhanced display name will now appear in CSV exports!");
