# Supply-Aware Portfolio Pricing Optimizer — Copilot Prompt

Use this prompt with a GitHub Copilot agent to implement a **portfolio-level daily pricing optimizer** for TCGplayer that is **supply-aware**. It extends the existing Velocity×Depth framework with a **supply-aware acceptance shift** and an optional **equilibrium anchor**.  
**Important:** avoid any static types; this will be integrated into an existing system.

---

## Business rules
- Platform: TCGplayer.
- Fees (seller pays): **15% of sale + $0.30** per item.
- Margin at price `p`: `margin(p) = 0.85*p - 0.30 - cogs`.
- Cost basis `cogs` is already stored per SKU (derived from buying at ≤ `0.75 * marketPrice - 0.30`).
- Objective (portfolio level): hit a **daily flow target** `F` (expected units sold today) while **maximizing total expected profit**.
- Daily operation with **hysteresis** to avoid churn.

## Data inputs per SKU
- `sales`: array of recent sales (each has `price`, `ageDays`).
- `listings`: array of current listings (each has `price`, `ship`).
- `cogs`, `marketPrice` (TCGplayer Market Price), `oldPrice` (optional), `weight` (optional priority).

## Core model (per SKU)
1) **Acceptance from sales (demand)**
   - Build a **decayed ECDF** of sale prices using weights `w = exp(-alpha * ageDays)` (default `alpha ≈ 0.05`).
   - Fit a **logistic CDF** `F(p) = 1 / (1 + exp(-(p - mu)/sigma))` to (price, ecdf) with **ml-levenberg-marquardt**.
   - Initialize:  
     - `mu0 = marketPrice` (TCG official)  
     - `sigma0` from **IQR** of **current listing totals** (`price+ship`) divided by `1.349` (cap to `[1e-3, 4*range]`).
   - Define **acceptance** `A(p) = 1 - F(p)`.

2) **Velocity (buyers per day)**
   - Estimate `lambda` = **decayed sales/day** over last 90 days: sum of decayed sales weights divided by sum of decayed day weights (for days 0..89).

3) **Depth / supply today**
   - Compute buyer-total for each listing = `price + ship`.
   - Sort ascending.  
   - `D(p)` = count of units **strictly cheaper** than `p` (treat equal-price competitors as **ahead** unless undercut by `minTick`, default `0.01`).
   - Cumulative supply `S(p) = D(p)`.

4) **Supply-aware acceptance shift**
   - Let `pm` = **decayed median** sale price; `IQR` = decayed interquartile range. Choose a horizon `T` (use `T=1` for daily flow).
   - Compute `mu_at_pm = lambda * T * A(pm)`.
   - Imbalance `I = mu_at_pm - S(pm)`.
     - `I > 0` ⇒ upward pressure (not enough supply at historical center).
     - `I < 0` ⇒ downward pressure.
   - Shift amount (bounded):  
     ```
     delta_raw = ( I / ( mu_at_pm + S(pm) + 1e-6 ) ) * IQR
     delta = clamp( kappa * delta_raw, -0.5*IQR, +0.5*IQR )   // kappa in [0.2, 0.7]
     ```
   - **Smooth** `delta` over days with EMA (half-life 3–5 days).
   - **Shifted acceptance**: `Atilde(p) = A(p - delta)`.

5) **Equilibrium anchor (optional)**
   - Demand over horizon at price `p`: `Qd(p) = lambda * T * Atilde(p)`.
   - Supply at/below `p`: `Qs(p) = S(p)`.
   - On the candidate grid (see below), find the smallest `p` where `Qd(p) ≥ Qs(p)`; call it `p_eq`.  
     Use `p_eq` as an **anchor**: discourage pricing far below it in rising markets and far above it in falling markets unless the profit objective requires it.

6) **Sale probability and expected profit**
   - Expected arrivals at `p`: `mu(p) = lambda * T * Atilde(p)`.
   - Position requirement: `k = D(p) + 1`.
   - Probability to sell within `T` days (Poisson):  
     `P_T(p) = 1 - PoissonCDF(k - 1, mu(p))`.
     - For over-dispersed markets (variance >> mean), support **Negative Binomial** tails; switch when `Var/Mean > 1.5`.
   - Expected profit today (for daily flow):  
     `E(p) = P_1(p) * margin(p)` (use `T=1` here).

## Candidate prices (per SKU)
- Build a compact grid of **knots** from current competitor totals:
  - each unique total, plus `-minTick` undercut and `+minTick` overcut.
  - Apply optional `priceFloor`/`priceCeiling`.
  - Enforce `margin(p) ≥ 0` (or a stronger ROI floor).
- For each candidate `p`, compute `{ P = P_1(p), E = E(p), margin }`.  
  (If using `T>1`, also compute `P_T` for SLA views.)

## Portfolio-level optimization
**Goal:**  
```
maximize   sum_j E_j(p_j)
subject to sum_j P_j(p_j) >= F
```
Implement **Lagrange multiplier + bisection**:
- For a given `lambda_bar ≥ 0`, each SKU independently picks `p` maximizing `E(p) + lambda_bar * (w_j * P(p))`, where `w_j` is an optional priority weight (aging, high COGS, etc.).
- Binary-search `lambda_bar` until the aggregate probability `sum P` meets `F` within `toleranceP`.
- If even `sum max P` < `F`, return the profit-max solution and mark `feasible=false`.

## Hysteresis & stability
- Only change a SKU’s price if both:
  - `abs(newPrice - oldPrice) ≥ hysteresisPrice` (e.g., `0.05`), and
  - `E(new) - E(old) ≥ hysteresisProfit` (e.g., `0.02`)  
  …unless a change is required to satisfy the portfolio flow `F`.
- Cap **reprices per SKU per day** (e.g., 2).
- **Depth smoothing**: optionally round candidate totals to nearest `0.05` to avoid penny whipsaw.
- **Velocity guardrails**: bound day-over-day change in `lambda` (e.g., ±40%).

## Minimal functions to implement (no types)
- `decayedECDF(sales, alpha)`
- `fitLogisticCDF(ecdf, marketPrice, listingTotals)` → returns `{ F(p), A(p), params }`
- `estimateVelocityPerDay(sales, alpha, lookbackDays)`
- `buildDepthAndKnots(listings, minTick)` → returns `{ D(p), knots }`
- `computeSupplyAwareShift(A, lambda, T, pm, IQR, S, kappa)` → returns `delta` (with EMA smoothing)
- `poissonTailAtLeast(kRequired, mu)` (and optional negative-binomial variant)
- `enumerateCandidates(sku, config)` → returns array of `{ price, P, E, margin }`
- `optimizePortfolio(skuCandidates, flowTargetF, options)` → returns selected candidate per SKU and summary `{ sumP, sumE, feasible, lambda_bar }`

## Config knobs (sensible defaults)
- `alpha = 0.05` (sales decay); `lookbackDays = 90`
- `minTick = 0.01`
- `kappa = 0.5`; `deltaClamp = 0.5 * IQR`; `deltaEMAHalfLife = 4 days`
- `toleranceP = 0.02`
- `hysteresisPrice = 0.05`; `hysteresisProfit = 0.02`
- `maxRepricesPerDay = 2`
- `useNBWhenDispersionOver = 1.5`
- Optional `priceFloor`, `priceCeiling`

## Implementation notes
- Language: JavaScript/TypeScript (no static types in signatures or exports).
- Only external dependency: **ml-levenberg-marquardt** for the logistic fit.
  ```js
  import { levenbergMarquardt as LM } from 'ml-levenberg-marquardt';
  ```
- Logistic fit:
  - Inputs: arrays `x = prices`, `y = ecdf`.
  - Bounds: `mu` within data range; `sigma` within `[1e-3, 4*range]`.
  - Init: `mu0 = marketPrice`; `sigma0 = IQR(listingTotals)/1.349` (fallback `range/8`).
  - Acceptance: `A(p) = 1 - logisticCDF(mu, sigma)(p)`.
- Use `Atilde(p) = A(p - delta)` everywhere you previously used `A(p)`.

## Optional: equilibrium anchor usage
- After building candidates, compute `p_eq` as the smallest candidate where `lambda * T * Atilde(p) >= S(p)`.
- Reject candidates that are:
  - much **below** `p_eq` in rising markets unless they substantially increase `E`, or
  - much **above** `p_eq` in falling markets unless the portfolio constraint forces it.  
  Use a small tolerance band around `p_eq` (e.g., ± one knot).

## Tests to include
- Rising market (few low listings, higher asks): `delta > 0`, chosen prices rise while meeting `F`.
- Falling market (pile of cheap listings): `delta < 0`, portfolio buys probability where `ΔE/ΔP` is cheapest.
- Stable: `delta ≈ 0`, low churn; portfolio ≥ per-SKU profit at same `F`.
- Erratic: switch to NB tails when `Var/Mean > threshold`; verify hysteresis throttles price flips.
- Infeasible flow: optimizer returns `feasible=false` and profit-max selection.

## Output (per SKU)
Return for each SKU:
- `selected.price`, `selected.P`, `selected.E`, `selected.margin`
- optional `reason` string (e.g., “meets portfolio flow at min cost; undercut by one tick to pass 3 listings”)

---

**Build the code now** following this prompt. Keep functions untyped, with clear comments where business rules enter (fees, margin floor, weights, supply-aware shift, equilibrium anchor).
