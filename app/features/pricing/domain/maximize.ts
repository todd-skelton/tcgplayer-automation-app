const GOLDEN_RATIO = (Math.sqrt(5) - 1) / 2;
const REFINEMENT_ITERATIONS = 24;

/**
 * Argument that maximizes a score. Every candidate is scored first so a
 * score with more than one peak cannot trap the search, then golden-section
 * search sharpens the answer between the neighbours of the best candidate.
 * The best candidate itself is kept when refinement cannot beat it, so an
 * optimum on a candidate is returned exactly.
 */
export function maximizeOverCandidates(
  candidates: readonly number[],
  score: (argument: number) => number,
): { argument: number; value: number } | undefined {
  const scores = candidates.map(score);
  const bestIndex = scores.indexOf(Math.max(...scores));
  if (bestIndex < 0) return undefined;
  const best = { argument: candidates[bestIndex], value: scores[bestIndex] };

  let low = candidates[Math.max(0, bestIndex - 1)];
  let high = candidates[Math.min(candidates.length - 1, bestIndex + 1)];
  if (low === high) return best;
  let lower = high - GOLDEN_RATIO * (high - low);
  let upper = low + GOLDEN_RATIO * (high - low);
  let lowerScore = score(lower);
  let upperScore = score(upper);
  for (let iteration = 0; iteration < REFINEMENT_ITERATIONS; iteration += 1) {
    if (lowerScore < upperScore) {
      low = lower;
      lower = upper;
      lowerScore = upperScore;
      upper = low + GOLDEN_RATIO * (high - low);
      upperScore = score(upper);
    } else {
      high = upper;
      upper = lower;
      upperScore = lowerScore;
      lower = high - GOLDEN_RATIO * (high - low);
      lowerScore = score(lower);
    }
  }
  const refined = (low + high) / 2;
  const refinedScore = score(refined);
  return refinedScore > best.value
    ? { argument: refined, value: refinedScore }
    : best;
}
