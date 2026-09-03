/**
 * Log-logistic model of portfolio value against target horizon:
 * value = floor + (ceiling − floor) / (1 + (midpointDays / horizonDays) ^ steepness).
 * Residual is the root-mean-square error in headroom fraction over the
 * samples the curve was fitted from.
 */
export interface HorizonValueCurve {
  floorValue: number;
  ceilingValue: number;
  midpointDays: number;
  steepness: number;
  residual: number;
}

export interface HorizonValueSample {
  horizonDays: number;
  value: number;
}

type HorizonShape = Pick<HorizonValueCurve, "midpointDays" | "steepness">;

/**
 * Headroom odds at the knee. On the log-horizon axis the logistic gain
 * decelerates fastest where captured / remaining headroom equals 2 + √3,
 * about 79% of headroom captured.
 */
const KNEE_HEADROOM_ODDS = 2 + Math.sqrt(3);
const SATURATION_LIMIT = 1e-3;
const MINIMUM_FIT_SAMPLES = 3;

/** Horizons spaced evenly in log space from minimum to maximum, endpoints exact. */
export function logSpacedHorizons(
  minimumDays: number,
  maximumDays: number,
  count: number,
): number[] {
  const lastIndex = count - 1;
  return Array.from({ length: count }, (_, index) =>
    index === 0
      ? minimumDays
      : index === lastIndex
        ? maximumDays
        : minimumDays * (maximumDays / minimumDays) ** (index / lastIndex),
  );
}

export function horizonHeadroomFraction(
  shape: HorizonShape,
  horizonDays: number,
): number {
  if (!(horizonDays > 0)) return 0;
  const offset =
    shape.steepness * (Math.log(horizonDays) - Math.log(shape.midpointDays));
  return 1 / (1 + Math.exp(-offset));
}

export function horizonValue(
  curve: HorizonValueCurve,
  horizonDays: number,
): number {
  return (
    curve.floorValue +
    (curve.ceilingValue - curve.floorValue) *
      horizonHeadroomFraction(curve, horizonDays)
  );
}

/** Dollars gained per additional day of horizon. */
export function horizonMarginalValuePerDay(
  curve: HorizonValueCurve,
  horizonDays: number,
): number {
  if (!(horizonDays > 0)) return 0;
  const fraction = horizonHeadroomFraction(curve, horizonDays);
  return (
    ((curve.ceilingValue - curve.floorValue) *
      fraction *
      (1 - fraction) *
      curve.steepness) /
    horizonDays
  );
}

/**
 * Percent change in gain over floor per percent change in horizon. Starts at
 * the steepness for short horizons and falls toward zero as value saturates.
 */
export function horizonGainElasticity(
  curve: HorizonValueCurve,
  horizonDays: number,
): number {
  return curve.steepness * (1 - horizonHeadroomFraction(curve, horizonDays));
}

/** Horizon at which gain per doubling of horizon decelerates fastest. */
export function horizonKneeDays(curve: HorizonShape): number {
  return curve.midpointDays * KNEE_HEADROOM_ODDS ** (1 / curve.steepness);
}

/**
 * Fits midpoint and steepness by weighted least squares of the headroom
 * logit against log horizon. Floor and ceiling are the exact values with
 * every SKU pinned at its fastest and slowest curve point, so they are inputs
 * rather than fitted coefficients. Saturated samples carry no slope
 * information and are left out of the regression but counted in the
 * residual, which is the root-mean-square error in headroom fraction.
 */
export function fitHorizonValueCurve(
  samples: readonly HorizonValueSample[],
  floorValue: number,
  ceilingValue: number,
): HorizonValueCurve | undefined {
  const headroom = ceilingValue - floorValue;
  if (!(headroom > 0)) return undefined;
  const points = samples
    .filter(
      (sample) =>
        sample.horizonDays > 0 &&
        Number.isFinite(sample.horizonDays) &&
        Number.isFinite(sample.value),
    )
    .map((sample) => ({
      horizonDays: sample.horizonDays,
      fraction: (sample.value - floorValue) / headroom,
    }));
  const interior = points.filter(
    ({ fraction }) =>
      fraction > SATURATION_LIMIT && fraction < 1 - SATURATION_LIMIT,
  );
  if (interior.length < MINIMUM_FIT_SAMPLES) return undefined;

  let weightSum = 0;
  let weightedX = 0;
  let weightedY = 0;
  let weightedXX = 0;
  let weightedXY = 0;
  for (const { horizonDays, fraction } of interior) {
    const logHorizon = Math.log(horizonDays);
    const weight = fraction * (1 - fraction);
    const logit = Math.log(fraction / (1 - fraction));
    weightSum += weight;
    weightedX += weight * logHorizon;
    weightedY += weight * logit;
    weightedXX += weight * logHorizon * logHorizon;
    weightedXY += weight * logHorizon * logit;
  }
  const denominator = weightSum * weightedXX - weightedX * weightedX;
  if (!(denominator > 0)) return undefined;
  const steepness =
    (weightSum * weightedXY - weightedX * weightedY) / denominator;
  const midpointDays = Math.exp(
    -(weightedY - steepness * weightedX) / weightSum / steepness,
  );
  if (!(steepness > 0) || !(midpointDays > 0) || !Number.isFinite(midpointDays))
    return undefined;

  const shape = { midpointDays, steepness };
  const squaredError = points.reduce((sum, point) => {
    const error =
      horizonHeadroomFraction(shape, point.horizonDays) - point.fraction;
    return sum + error * error;
  }, 0);
  return {
    floorValue,
    ceilingValue,
    ...shape,
    residual: Math.sqrt(squaredError / points.length),
  };
}
