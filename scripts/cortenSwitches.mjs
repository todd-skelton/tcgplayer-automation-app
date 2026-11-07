/**
 * The switches in `.env.production.local` that moved each Node job to the Corten app, one per
 * release (docs/prod-cutover.md). Release 8 removes the Node app, so it runs only once every one is
 * set: each job then already runs in the Corten app, proven by its own release.
 */
export const CORTEN_SWITCHES = [
  "SELLER_ORDER_HISTORY_WORKER",
  "PRICING_WORKER",
  "CONTINUOUS_PRICING_SCHEDULER",
  "SLAB_EVIDENCE_WORKER",
  "PUBLICATION_WORKER",
  "MIGRATE_ON_START",
];

/** The switches `env` leaves unset or blank, as the Corten app reads a switch, in release order. */
export function unsetSwitches(env) {
  return CORTEN_SWITCHES.filter((name) => !env[name]?.trim());
}
