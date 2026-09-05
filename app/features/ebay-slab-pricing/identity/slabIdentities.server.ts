import { randomUUID } from "node:crypto";
import { queryOne } from "~/core/db/database.server";
import { createProviderRequest } from "../connections/providerRequest.server";
import { providerRequestGate } from "../connections/providerConnections.server";
import { createAltIdentityProvider } from "./altIdentityProvider.server";
import {
  createSlabIdentityService,
  type IdentityStore,
} from "./slabIdentityService.server";
import type { StoredSlabIdentity } from "./slabIdentity";

const COLUMNS = `id, grader, certificate_number AS "certificateNumber", candidate, identity, status,
  review_reasons AS "reviewReasons", valuation_group_key AS "valuationGroupKey", revision,
  decision_source AS "decisionSource", decision_note AS "decisionNote", updated_at AS "updatedAt"`;
export const slabIdentityStore: IdentityStore = {
  find: (certificate) =>
    queryOne<StoredSlabIdentity>(
      `SELECT ${COLUMNS} FROM slab_identities WHERE grader = $1 AND certificate_number = $2`,
      [certificate.grader, certificate.certificateNumber],
    ),
  async saveCandidate(certificate, candidate, reasons, revision) {
    let result: StoredSlabIdentity | null;
    if (revision === undefined) {
      result = await queryOne<StoredSlabIdentity>(
        `INSERT INTO slab_identities (id, grader, certificate_number, candidate, review_reasons)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (grader, certificate_number) DO NOTHING RETURNING ${COLUMNS}`,
        [
          randomUUID(),
          certificate.grader,
          certificate.certificateNumber,
          JSON.stringify(candidate),
          JSON.stringify(reasons),
        ],
      );
    } else {
      result = await queryOne<StoredSlabIdentity>(
        `UPDATE slab_identities SET candidate = $3, review_reasons = $4,
        revision = revision + 1, updated_at = clock_timestamp() WHERE grader = $1 AND certificate_number = $2
        AND revision = $5 AND status <> 'confirmed' RETURNING ${COLUMNS}`,
        [
          certificate.grader,
          certificate.certificateNumber,
          JSON.stringify(candidate),
          JSON.stringify(reasons),
          revision,
        ],
      );
    }
    return result ?? (await slabIdentityStore.find(certificate))!;
  },
  confirm: (certificate, revision, identity, key, note) =>
    queryOne<StoredSlabIdentity>(
      `UPDATE slab_identities
    SET identity = $4, valuation_group_key = $5, status = 'confirmed', review_reasons = '[]',
      revision = revision + 1, decision_source = 'manual', decision_note = $6, updated_at = clock_timestamp()
    WHERE grader = $1 AND certificate_number = $2 AND revision = $3 RETURNING ${COLUMNS}`,
      [
        certificate.grader,
        certificate.certificateNumber,
        revision,
        JSON.stringify(identity),
        key,
        note,
      ],
    ),
};

export const slabIdentityService = createSlabIdentityService({
  store: slabIdentityStore,
  lookupCertificate: createAltIdentityProvider(
    createProviderRequest(providerRequestGate),
  ),
});
