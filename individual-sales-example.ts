/**
 * Example demonstrating the difference between average-based and individual sales-based Zipf modeling
 */

// Example sales data for a card across different conditions
const exampleSalesData = [
  // Near Mint sales (rank 1)
  { condition: "Near Mint", price: 100, timestamp: Date.now() - 86400000 },
  { condition: "Near Mint", price: 95, timestamp: Date.now() - 172800000 },
  { condition: "Near Mint", price: 105, timestamp: Date.now() - 259200000 },

  // Lightly Played sales (rank 2)
  { condition: "Lightly Played", price: 80, timestamp: Date.now() - 86400000 },
  { condition: "Lightly Played", price: 75, timestamp: Date.now() - 172800000 },
  { condition: "Lightly Played", price: 85, timestamp: Date.now() - 259200000 },
  { condition: "Lightly Played", price: 70, timestamp: Date.now() - 345600000 },

  // Moderately Played sales (rank 3)
  {
    condition: "Moderately Played",
    price: 60,
    timestamp: Date.now() - 86400000,
  },
  {
    condition: "Moderately Played",
    price: 55,
    timestamp: Date.now() - 172800000,
  },

  // Heavily Played sales (rank 4)
  { condition: "Heavily Played", price: 40, timestamp: Date.now() - 86400000 },
  { condition: "Heavily Played", price: 45, timestamp: Date.now() - 172800000 },
  { condition: "Heavily Played", price: 35, timestamp: Date.now() - 259200000 },

  // Damaged sales (rank 5)
  { condition: "Damaged", price: 25, timestamp: Date.now() - 86400000 },
];

console.log(
  "=== COMPARISON: Average-based vs Individual Sales-based Zipf Modeling ===\n"
);

// OLD APPROACH: Average-based
console.log("OLD APPROACH (Using averages):");
const averagesByCondition = {
  "Near Mint": 100, // (100 + 95 + 105) / 3
  "Lightly Played": 77.5, // (80 + 75 + 85 + 70) / 4
  "Moderately Played": 57.5, // (60 + 55) / 2
  "Heavily Played": 40, // (40 + 45 + 35) / 3
  Damaged: 25, // 25 / 1
};

console.log(
  "Data points for fitting:",
  Object.entries(averagesByCondition)
    .map(([condition, price], index) => `rank ${index + 1}: $${price}`)
    .join(", ")
);
console.log("Total data points:", Object.keys(averagesByCondition).length);

// NEW APPROACH: Individual sales
console.log("\nNEW APPROACH (Using individual sales):");
const individualDataPoints = exampleSalesData.map((sale) => {
  const conditions = [
    "Near Mint",
    "Lightly Played",
    "Moderately Played",
    "Heavily Played",
    "Damaged",
  ];
  const rank = conditions.indexOf(sale.condition) + 1;
  return `rank ${rank}: $${sale.price}`;
});

console.log("Data points for fitting:", individualDataPoints.join(", "));
console.log("Total data points:", exampleSalesData.length);

console.log("\n=== KEY ADVANTAGES OF INDIVIDUAL SALES APPROACH ===");
console.log("✓ Captures price variance within each condition");
console.log("✓ More data points for better curve fitting");
console.log("✓ Preserves outliers that might indicate market trends");
console.log("✓ Better statistical significance with more observations");
console.log(
  "✓ Accounts for price distribution shape, not just central tendency"
);

console.log("\n=== EXAMPLE IMPACT ===");
console.log(
  "• Near Mint condition shows $10 price range (could indicate reprints, condition subjectivity)"
);
console.log(
  "• Lightly Played has $15 range (reflects varying degrees of play wear)"
);
console.log("• Individual outliers (like $70 LP sale) provide market insight");
console.log(
  "• Model can detect if price relationships are truly logarithmic/Zipf-like"
);

export { exampleSalesData, averagesByCondition };
