/**
 * Demonstration script for the enhanced getSuggestedPriceFromLatestSales function
 * This shows how the algorithm handles cross-condition analysis with Zipf modeling
 */

import { getSuggestedPriceFromLatestSales } from "./app/algorithms/getSuggestedPriceFromLatestSales";
import type { Sku } from "./app/data-types/sku";

// Example SKU with limited sales data in the target condition
const testSku: Sku = {
  sku: 123456,
  condition: "Near Mint",
  variant: "Holofoil",
  language: "English",
  productTypeName: "Cards",
  rarityName: "Rare",
  sealed: false,
  productName: "Test Card",
  setId: 1,
  setCode: "TST",
  productId: 12345,
  setName: "Test Set",
  productLineId: 1,
  productStatusId: 1,
  productLineName: "Test Product Line",
};

async function demonstrateZipfPricing() {
  try {
    console.log("Testing enhanced price suggestion with Zipf modeling...");
    console.log("SKU:", testSku.productName, "-", testSku.condition);

    const result = await getSuggestedPriceFromLatestSales(testSku, {
      percentile: 80,
      halfLifeDays: 7,
    });

    console.log("\n=== PRICING RESULTS ===");
    console.log("Suggested Price:", result.suggestedPrice?.toFixed(2) || "N/A");
    console.log("Total Sales Count:", result.saleCount);
    console.log("Total Quantity:", result.totalQuantity);
    console.log(
      "Expected Time to Sell (days):",
      result.expectedTimeToSellDays?.toFixed(1) || "N/A"
    );
    console.log(
      "Used Cross-condition Analysis:",
      result.usedCrossConditionAnalysis
    );

    if (result.conditionMultipliers) {
      console.log("\n=== CONDITION MULTIPLIERS (Zipf Model) ===");
      result.conditionMultipliers.forEach((multiplier, condition) => {
        console.log(`${condition}: ${multiplier.toFixed(3)}x`);
      });
    }

    console.log("\n=== PERCENTILE BREAKDOWN ===");
    result.percentiles.forEach((p) => {
      console.log(
        `${p.percentile}th percentile: $${p.price.toFixed(2)} ` +
          `(ETA: ${p.expectedTimeToSellDays?.toFixed(1) || "N/A"} days)`
      );
    });

    if (result.usedCrossConditionAnalysis) {
      console.log("\n=== ANALYSIS NOTES ===");
      console.log("• Insufficient sales data for target condition");
      console.log("• Fetched sales from all conditions");
      console.log("• Applied Zipf model to normalize prices");
      console.log("• Used Levenberg-Marquardt optimization for curve fitting");
    }
  } catch (error) {
    console.error("Error demonstrating Zipf pricing:", error);
  }
}

// Run the demonstration if this file is executed directly
if (require.main === module) {
  demonstrateZipfPricing();
}

export { demonstrateZipfPricing };
