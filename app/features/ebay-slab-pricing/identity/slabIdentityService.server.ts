import { createHash } from "node:crypto";
import {
  CARD_FIELDS,
  identityConflicts,
  normalizeCertificate,
  normalizeExpectedIdentity,
  parseSlabIdentity,
  SlabIdentityError,
  textField,
  type ExpectedSlabIdentity,
  type Certificate,
  type IdentityCandidate,
  type SlabIdentity,
  type StoredSlabIdentity,
} from "./slabIdentity";

export type IdentityStore = {
  find(certificate: Certificate): Promise<StoredSlabIdentity | null>;
  saveCandidate(
    certificate: Certificate,
    candidate: IdentityCandidate | null,
    reasons: string[],
    revision?: number,
  ): Promise<StoredSlabIdentity>;
  confirm(
    certificate: Certificate,
    revision: number,
    identity: SlabIdentity,
    groupKey: string,
    note: string,
  ): Promise<StoredSlabIdentity | null>;
};

export function valuationGroupKey(identity: SlabIdentity): string {
  // Ordered fields, explicit nulls and label/qualifier distinctions; no certificate/listing IDs.
  const normalized = (value: string | null) =>
    value?.trim().toLowerCase() ?? null;
  const fields = [
    ...CARD_FIELDS.map((field) => normalized(identity.card[field])),
    identity.providerAsset?.provider ?? null,
    identity.providerAsset?.id ?? null,
    identity.grading.grader,
    identity.grading.number ?? identity.grading.encoding,
    normalized(identity.grading.label),
    normalized(identity.grading.qualifier),
    normalized(identity.grading.autograph),
  ];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

export function createSlabIdentityService(dependencies: {
  store: IdentityStore;
  lookupCertificate: (
    certificateNumber: string,
    signal?: AbortSignal,
  ) => Promise<IdentityCandidate | null>;
}) {
  return {
    async lookup(
      input: Certificate,
      options: {
        expected?: ExpectedSlabIdentity;
        refresh?: boolean;
        signal?: AbortSignal;
      } = {},
    ) {
      const certificate = normalizeCertificate(input);
      const expected = normalizeExpectedIdentity(options.expected);
      let record = await dependencies.store.find(certificate);
      if (!record || (options.refresh && record.status !== "confirmed")) {
        const candidate = await dependencies.lookupCertificate(
          certificate.certificateNumber,
          options.signal,
        );
        const reasons =
          candidate === null
            ? ["certificate-not-found"]
            : [
                ...(candidate.certificateNumber !==
                certificate.certificateNumber
                  ? ["certificate-mismatch"]
                  : []),
                ...(candidate.grader !== certificate.grader
                  ? ["grader-mismatch"]
                  : []),
                ...(candidate.identity.grading.label === null
                  ? ["grade-label-unresolved"]
                  : []),
                "confirmation-required",
              ];
        record = await dependencies.store.saveCandidate(
          certificate,
          candidate,
          reasons,
          record?.revision,
        );
      }
      return {
        record,
        reviewReasons: [
          ...record.reviewReasons,
          ...identityConflicts(
            record.identity ?? record.candidate?.identity ?? null,
            expected,
          ),
        ],
      };
    },
    async confirm(
      input: Certificate,
      revision: number,
      value: unknown,
      reason: unknown,
    ) {
      const certificate = normalizeCertificate(input);
      const identity = parseSlabIdentity(value);
      const note = textField(reason, 1000);
      if (
        !Number.isSafeInteger(revision) ||
        revision < 1 ||
        !note ||
        identity.grading.grader !== certificate.grader ||
        !identity.grading.label
      ) {
        throw new SlabIdentityError(
          "invalid-input",
          "Confirm the grader and exact grade label, and record the reason for this identity decision.",
        );
      }
      const record = await dependencies.store.confirm(
        certificate,
        revision,
        identity,
        valuationGroupKey(identity),
        note,
      );
      if (!record)
        throw new SlabIdentityError(
          "conflict",
          "The identity changed. Reload it before confirming.",
        );
      return record;
    },
  };
}
