import {
  CARD_FIELDS,
  SlabIdentityError,
  textField,
  type CardIdentity,
  type SlabIdentity,
} from "./slabIdentity";

export function altGrading(
  attributes: Record<string, unknown>,
  label?: unknown,
): SlabIdentity["grading"] {
  const grader =
    textField(attributes.gradingCompany, 40)?.toUpperCase() ?? "UNKNOWN";
  const encoding =
    textField(attributes.gradeNumber ?? attributes.grade, 40) ?? "unknown";
  const numeric = /^\d+(?:\.\d+)?$/.test(encoding) ? Number(encoding) : NaN;
  // Only PSA's ordinary numeric encoding is verified. Preserve other encodings verbatim.
  const number =
    grader === "PSA" &&
    numeric >= 1 &&
    numeric <= 10 &&
    numeric !== 9.5 &&
    (numeric * 2) % 1 === 0
      ? numeric
      : null;
  return {
    grader,
    encoding,
    number,
    label: textField(label) ?? (number === null ? null : `PSA ${number}`),
    qualifier: textField(attributes.qualifier),
    autograph: textField(attributes.autograph),
  };
}

export function altCard(asset: Record<string, unknown>): CardIdentity {
  const attributes = asset.attributes as Record<string, unknown> | null;
  if (
    attributes != null &&
    (typeof attributes !== "object" || Array.isArray(attributes))
  )
    throw new SlabIdentityError("invalid-input", "Invalid card attributes.");
  if (
    asset.year != null &&
    (typeof asset.year !== "number" || !Number.isSafeInteger(asset.year))
  )
    throw new SlabIdentityError("invalid-input", "Invalid card year.");
  const fields = {
    name: asset.subject ?? asset.name,
    game: asset.category === "POKEMON_CARDS" ? "Pokemon" : null,
    language: null,
    set: asset.brand,
    cardNumber: attributes?.cardNumber,
    year: asset.year == null ? null : String(asset.year),
    edition: asset.variety === "1st Edition" ? "1st Edition" : null,
    finish: ["Reverse Holo", "Holo", "Non-Holo"].includes(String(asset.variety))
      ? asset.variety
      : null,
    stamp: null,
  };
  const card = Object.fromEntries(
    CARD_FIELDS.map((field) => [field, textField(fields[field])]),
  ) as CardIdentity;
  if (!card.name)
    throw new SlabIdentityError("invalid-input", "Missing card name.");
  return card;
}
