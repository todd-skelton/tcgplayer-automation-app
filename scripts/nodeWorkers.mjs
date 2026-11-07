/**
 * The Node worker services in docker-compose.prod.yml and the switch that hands each one's work to
 * the Corten app. A service whose switch is set is removed rather than left running: Node's pricing
 * worker does not read its switch, so both would claim from one queue, and a worker that exits on
 * its switch would be restarted in a loop by `restart: unless-stopped`.
 */
export const NODE_WORKER_SWITCHES = {
  "pricing-worker": "PRICING_WORKER",
  "pricing-scheduler": "CONTINUOUS_PRICING_SCHEDULER",
  "slab-evidence-worker": "SLAB_EVIDENCE_WORKER",
  "publication-worker": "PUBLICATION_WORKER",
};

/** Whether `env` sets `name` to something other than blanks, as the Corten app reads a switch. */
const isSet = (env, name) => Boolean(env[name]?.trim());

/** The Node worker services to run and those the Corten app has taken over, in that order. */
export function nodeWorkerServices(env) {
  const services = Object.keys(NODE_WORKER_SWITCHES);
  return {
    running: services.filter((service) => !isSet(env, NODE_WORKER_SWITCHES[service])),
    retired: services.filter((service) => isSet(env, NODE_WORKER_SWITCHES[service])),
  };
}