export const CARD_FIELDS = [
  "name",
  "game",
  "language",
  "set",
  "cardNumber",
  "year",
  "edition",
  "finish",
  "stamp",
] as const;
export type CardIdentity = Record<(typeof CARD_FIELDS)[number], string | null>;
export type SlabIdentity = {
  card: CardIdentity;
  grading: {
    grader: string;
    encoding: string;
    number: number | null;
    label: string | null;
    qualifier: string | null;
    autograph: string | null;
  };
  providerAsset: { provider: "alt"; id: string; title: string | null } | null;
};
export type Certificate = { grader: string; certificateNumber: string };
export type ExpectedSlabIdentity = Partial<CardIdentity> & {
  gradeNumber?: number | null;
  gradeLabel?: string | null;
  qualifier?: string | null;
  autograph?: string | null;
};
export type IdentityCandidate = Certificate & { identity: SlabIdentity };
export type StoredSlabIdentity = Certificate & {
  id: string;
  candidate: IdentityCandidate | null;
  identity: SlabIdentity | null;
  status: "needs-review" | "confirmed";
  reviewReasons: string[];
  valuationGroupKey: string | null;
  revision: number;
  decisionSource: "alt" | "manual";
  decisionNote: string | null;
  updatedAt: Date;
};
export class SlabIdentityError extends Error {
  constructor(
    public readonly code: "invalid-input" | "conflict" | "not-found",
    message: string,
  ) {
    super(message);
  }
}
export function textField(value: unknown, max = 200): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\x00-\x1f]/.test(value)
  ) {
    throw new SlabIdentityError(
      "invalid-input",
      "Identity fields must be short text values.",
    );
  }
  return value.trim() || null;
}
export function normalizeCertificate(value: Certificate): Certificate {
  const grader = textField(value.grader, 40)?.toUpperCase();
  const certificateNumber = textField(value.certificateNumber, 80);
  if (
    !grader ||
    !certificateNumber ||
    !/^[A-Z0-9 -]+$/.test(grader) ||
    !/^[a-zA-Z0-9-]+$/.test(certificateNumber)
  ) {
    throw new SlabIdentityError(
      "invalid-input",
      "Enter a grader and certificate number.",
    );
  }
  return { grader, certificateNumber };
}
export function parseSlabIdentity(value: unknown): SlabIdentity {
  const input = value as SlabIdentity | null;
  if (!input || typeof input !== "object" || !input.card || !input.grading) {
    throw new SlabIdentityError(
      "invalid-input",
      "Provide card identity and grading details.",
    );
  }
  const card = Object.fromEntries(
    CARD_FIELDS.map((field) => [field, textField(input.card[field])]),
  ) as CardIdentity;
  const grader = textField(input.grading.grader, 40)?.toUpperCase();
  const encoding = textField(input.grading.encoding, 40);
  const number = input.grading.number ?? null;
  if (
    !card.name ||
    !grader ||
    !encoding ||
    (number !== null &&
      (typeof number !== "number" ||
        !Number.isFinite(number) ||
        number < 1 ||
        number > 10 ||
        (number * 2) % 1 !== 0))
  ) {
    throw new SlabIdentityError(
      "invalid-input",
      "Provide a card name, grader and original grade encoding. Numeric grades must be between 1 and 10.",
    );
  }
  let providerAsset: SlabIdentity["providerAsset"] = null;
  if (input.providerAsset) {
    const id = textField(input.providerAsset.id, 80);
    if (
      input.providerAsset.provider !== "alt" ||
      !id ||
      !/^[a-zA-Z0-9-]+$/.test(id)
    ) {
      throw new SlabIdentityError(
        "invalid-input",
        "Provide a valid provider asset reference.",
      );
    }
    providerAsset = {
      provider: "alt",
      id,
      title: textField(input.providerAsset.title, 500),
    };
  }
  return {
    card,
    grading: {
      grader,
      encoding,
      number,
      label: textField(input.grading.label),
      qualifier: textField(input.grading.qualifier),
      autograph: textField(input.grading.autograph),
    },
    providerAsset,
  };
}
export function normalizeExpectedIdentity(
  expected: ExpectedSlabIdentity = {},
): ExpectedSlabIdentity {
  const gradeNumber = expected.gradeNumber ?? null;
  if (
    gradeNumber !== null &&
    (typeof gradeNumber !== "number" ||
      !Number.isFinite(gradeNumber) ||
      gradeNumber < 1 ||
      gradeNumber > 10)
  ) {
    throw new SlabIdentityError(
      "invalid-input",
      "Expected numeric grade must be between 1 and 10.",
    );
  }
  return {
    ...Object.fromEntries(
      CARD_FIELDS.map((field) => [field, textField(expected[field])]),
    ),
    gradeNumber,
    gradeLabel: textField(expected.gradeLabel),
    qualifier: textField(expected.qualifier),
    autograph: textField(expected.autograph),
  };
}
export function identityConflicts(
  identity: SlabIdentity | null,
  expected: ExpectedSlabIdentity = {},
): string[] {
  const conflicts = CARD_FIELDS.flatMap((field) => {
    const wanted = textField(expected[field]);
    if (!wanted) return [];
    const actual = identity?.card[field];
    return actual?.toLowerCase() === wanted.toLowerCase()
      ? []
      : [`inventory-${field}-mismatch`];
  });
  if (
    expected.gradeNumber != null &&
    identity?.grading.number !== expected.gradeNumber
  )
    conflicts.push("inventory-grade-mismatch");
  for (const [field, actual] of [
    ["gradeLabel", identity?.grading.label],
    ["qualifier", identity?.grading.qualifier],
    ["autograph", identity?.grading.autograph],
  ] as const) {
    const wanted = textField(expected[field]);
    if (wanted && actual?.toLowerCase() !== wanted.toLowerCase())
      conflicts.push(`inventory-${field}-mismatch`);
  }
  return conflicts;
}
export function isCurrentIdentity(
  record: StoredSlabIdentity,
  reference: { slabId: string; revision: number; valuationGroupKey: string },
): boolean {
  return (
    record.status === "confirmed" &&
    record.id === reference.slabId &&
    record.revision === reference.revision &&
    record.valuationGroupKey === reference.valuationGroupKey
  );
}
