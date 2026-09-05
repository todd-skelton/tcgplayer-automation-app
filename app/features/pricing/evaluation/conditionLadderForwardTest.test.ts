import assert from "node:assert/strict";
import type { ListingSnapshot } from "~/core/db/repositories/productListingSnapshots.server";
import type { RecordedSale } from "~/core/db/repositories/productSales.server";
import type { WeeklySales } from "~/core/db/repositories/productWeeklySales.server";
import type { Condition } from "~/integrations/tcgplayer/types/Condition";
import {
  CANDIDATES,
  fitPopulationPrior,
  gatherEvidence,
  runConditionLadderForwardTest,
  summarizeForwardTest,
  weeklyCutoffs,
  type Candidate,
} from "./conditionLadderForwardTest";

const DAY = 86_400_000;
const cutoff = Date.parse("2026-09-01T00:00:00.000Z");
const isoDate = (time: number) => new Date(time).toISOString().slice(0, 10);

function sale(
  condition: Condition,
  price: number,
  daysFromCutoff: number,
  productId = 1,
): RecordedSale {
  return {
    productId,
    condition,
    variant: "Holofoil",
    language: "English",
    quantity: 1,
    title: "",
    listingType: "ListingWithoutPhotos",
    customListingId: "0",
    purchasePrice: price,
    shippingPrice: 0,
    orderDate: new Date(cutoff + daysFromCutoff * DAY).toISOString(),
  };
}

function week(
  condition: Condition,
  price: number,
  transactions: number,
  weeksBeforeCutoff: number,
  productId = 1,
  marketPrice: number | null = price,
): WeeklySales {
  return {
    productId,
    skuId: productId * 10 + ["Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged"].indexOf(condition),
    condition,
    variant: "Holofoil",
    language: "English",
    weekStart: isoDate(cutoff - weeksBeforeCutoff * 7 * DAY),
    transactions,
    quantity: transactions,
    lowSalePrice: price,
    highSalePrice: price,
    lowSalePriceWithShipping: price,
    highSalePriceWithShipping: price,
    tcgMarketPrice: marketPrice,
  };
}

function ask(condition: Condition, price: number, productId = 1): ListingSnapshot {
  return {
    productId,
    variant: "Holofoil",
    language: "English",
    condition,
    observedOn: isoDate(cutoff - DAY),
    sellerCount: 3,
    cheapestDeliveredPrice: price,
    secondCheapestDeliveredPrice: price * 1.1,
  };
}

// A card whose Near Mint sells at $10, Lightly Played at $8, Moderately Played
// at $6.50: a Zipf exponent near 0.35 fits all three. The recorded sales of
// the last 30 days are Near Mint only, so production cannot fit an exponent
// from them and falls back to the market prices; the weekly sales of the 40
// weeks before carry the other conditions' history for the pooled fits.
const steepCard = {
  sales: [
    ...[-28, -21, -14, -7, -2].map((day) => sale("Near Mint", 10, day)),
    sale("Near Mint", 10, 3),
    sale("Lightly Played", 8, 5),
    sale("Heavily Played", 5, 7),
  ],
  weeklySales: [
    ...Array.from({ length: 40 }, (_, index) => week("Near Mint", 10, 4, index + 5)),
    ...Array.from({ length: 20 }, (_, index) => week("Lightly Played", 8, 1, index * 2 + 5)),
    ...Array.from({ length: 8 }, (_, index) => week("Moderately Played", 6.5, 1, index * 5 + 6)),
  ],
  listingSnapshots: [ask("Near Mint", 10.5), ask("Lightly Played", 8.4), ask("Heavily Played", 5.2)],
};

{
  const cards = gatherEvidence(steepCard);
  assert.equal(cards.length, 1);
  const [card] = cards;
  const recorded = card.observations.filter((row) => row.sale);
  const weekly = card.observations.filter((row) => !row.sale);
  assert.equal(recorded.length, steepCard.sales.length);
  // Weeks overlapping the recorded sales are left out so nothing is counted twice.
  const firstRecorded = Math.min(...recorded.map((row) => row.time));
  assert.ok(weekly.every((row) => row.time < firstRecorded));
  assert.ok(weekly.some((row) => row.count === 4));
  assert.equal(card.asks.length, 3);
  console.log("PASS evidence joins recorded sales with the weekly sales before them");
}

const scores = runConditionLadderForwardTest(steepCard, { cutoffs: [cutoff], horizonDays: 14 });
const pick = (candidate: Candidate, scenario: string, condition: Condition) =>
  scores.filter((s) => s.candidate === candidate && s.scenario === scenario && s.condition === condition);

for (const candidate of CANDIDATES) {
  const nearMint = pick(candidate, "seen", "Near Mint");
  assert.equal(nearMint.length, 1, candidate);
  assert.ok(Math.abs(nearMint[0].signedError) < 0.05, `${candidate} Near Mint ${nearMint[0].predicted}`);
}
console.log("PASS every candidate recovers a seen condition's level from its own sales");

{
  // Heavily Played never traded before the cutoff. Production has no market
  // price for it either, so it values it as Moderately Played; the pooled
  // fits carry the card's own exponent, read from a year of weekly sales,
  // down to it.
  const production = pick("production", "unseen", "Heavily Played")[0];
  const pooled = pick("pooled zipf", "unseen", "Heavily Played")[0];
  const free = pick("free rungs", "unseen", "Heavily Played")[0];
  const withAsks = pick("pooled zipf + asks", "unseen", "Heavily Played")[0];
  assert.ok(production && pooled && free && withAsks);
  assert.ok(Math.abs(production.predicted - 6.5) < 0.05, `production ${production.predicted}`);
  assert.ok(pooled.predicted < production.predicted, `pooled ${pooled.predicted}`);
  assert.ok(Math.abs(pooled.signedError) < Math.abs(production.signedError));
  assert.ok(Math.abs(free.predicted - pooled.predicted) < 0.6, `free ${free.predicted} pooled ${pooled.predicted}`);
  // The $5.20 ask pulls the estimate toward the truth.
  assert.ok(Math.abs(withAsks.signedError) <= Math.abs(pooled.signedError) + 1e-9);
  console.log("PASS an unseen condition is valued from the card's own ladder, not as its neighbour");
}

{
  // Removing a condition's evidence also removes its market price, so "unseen" is a fair test.
  const seen = pick("production", "seen", "Lightly Played")[0];
  const unseen = pick("production", "unseen", "Lightly Played")[0];
  assert.ok(seen && unseen);
  assert.ok(Math.abs(seen.signedError) < 0.05);
  assert.ok(unseen.predicted > seen.predicted, "without its own evidence production values Lightly Played as Near Mint");
  console.log("PASS the unseen scenario hides the condition's sales and market price alike");
}

{
  const summaries = summarizeForwardTest(scores);
  const pooled = summaries.find(
    (row) => row.scenario === "unseen" && row.candidate === "pooled zipf" && row.condition === "all",
  );
  const production = summaries.find(
    (row) => row.scenario === "unseen" && row.candidate === "production" && row.condition === "all",
  );
  assert.ok(pooled && production);
  assert.equal(production.betterThanProduction, undefined);
  assert.ok(pooled.betterThanProduction !== undefined && pooled.betterThanProduction > 0);
  assert.ok(pooled.count >= 3);
  console.log("PASS summaries pair each candidate against production on the same sales");
}

{
  const prior = fitPopulationPrior([
    { level: Math.log(1), exponent: 0.1, information: 5 },
    { level: Math.log(100), exponent: 0.5, information: 5 },
  ]);
  assert.equal(prior.slope, 0);
  assert.ok(Math.abs(prior.intercept - 0.3) < 1e-9);
  const sloped = fitPopulationPrior(
    Array.from({ length: 12 }, (_, index) => ({
      level: index / 3,
      exponent: 0.1 + 0.1 * (index / 3),
      information: 5,
    })),
  );
  assert.ok(Math.abs(sloped.intercept - 0.1) < 1e-6);
  assert.ok(Math.abs(sloped.slope - 0.1) < 1e-6);
  console.log("PASS the population prior is a line in log value once enough cards inform it");
}

{
  const cutoffs = weeklyCutoffs([sale("Near Mint", 1, -30), sale("Near Mint", 1, 0)], { horizonDays: 14 });
  assert.equal(cutoffs.length, 3);
  assert.equal(cutoffs[0], cutoff - 30 * DAY);
  assert.deepEqual(weeklyCutoffs([]), []);
  console.log("PASS weekly cutoffs span the recorded sales and leave a horizon of truth");
}
