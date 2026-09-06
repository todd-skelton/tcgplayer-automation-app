import { CARD_FIELDS, type SlabIdentity } from "../identity/slabIdentity";
import type { SaleEvidence } from "../evidence/slabEvidence";

export type CompReason = {
  code: string;
  field?: string;
  expected?: string | number | null;
  actual?: string | number | null;
  severity: "review" | "reject";
};
export const words = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const normalizeField = (field: string, value: string) => {
  const text = words(value);
  if (field === "game") return text === "pokemon tcg" ? "pokemon" : text;
  if (field === "edition")
    return /^(1st|first)( edition)?$/.test(text) ? "1st edition" : text;
  if (field === "cardNumber")
    return value
      .replace(/^#/, "")
      .split("/")
      .map((part) =>
        part
          .trim()
          .toLowerCase()
          .replace(/^0+(?=\d)/, ""),
      )
      .join("/");
  return text;
};
function sameField(field: string, a: string, b: string) {
  const first = normalizeField(field, a),
    second = normalizeField(field, b);
  if (field === "cardNumber" && (!first.includes("/") || !second.includes("/")))
    return first.split("/")[0] === second.split("/")[0];
  return first === second;
}
export function gradeLabelKey(
  grader: string,
  label: string | null,
  number: number | null,
): string | null {
  if (!label) return null;
  const labelNumbers = (label.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (number !== null && labelNumbers.some((value) => value !== number))
    return `${grader}:inconsistent:${words(label)}`;
  const text = words(label)
    .replace(/^(psa|cgc|bgs|sgc)\s*/, "")
    .trim();
  if (grader === "PSA" && number !== null) {
    const descriptor = text
      .replace(/\b\d+(?:\s\d+)?\b/g, "")
      .replace(/\b(oc|mc|st|pd|of|mk)\b/g, "")
      .trim();
    const standard: Record<string, string[]> = {
      "1": ["poor", "pr"],
      "2": ["good", "gd"],
      "3": ["very good", "vg"],
      "4": ["vg ex", "very good excellent"],
      "5": ["excellent", "ex"],
      "6": ["ex mt", "excellent mint"],
      "7": ["near mint", "nm"],
      "8": ["nm mt", "near mint mint"],
      "9": ["mint", "mt"],
      "10": ["gem mint", "gem mt"],
    };
    if (!descriptor || standard[String(number)]?.includes(descriptor))
      return `PSA:${number}`;
  }
  if (grader === "CGC" || grader === "BGS" || grader === "SGC") {
    if (/\bblack label\b/.test(text)) return `${grader}:black-label:${number}`;
    if (/\bpristine\b/.test(text)) return `${grader}:pristine:${number}`;
    if (/\bperfect\b/.test(text)) return `${grader}:perfect:${number}`;
    if (/\bgem mint\b/.test(text)) return `${grader}:gem-mint:${number}`;
    if (/^[\d\s]+$/.test(text)) return null; // A CGC 10 alone is not a Gem Mint/Pristine label.
  }
  return `${grader}:${text}`;
}

export function titleFacts(text: string) {
  const normalized = words(text);
  const languages: Record<string, RegExp> = {
    English: /\benglish\b/,
    Spanish: /\b(spanish|espanol)\b/,
    Japanese: /\b(japanese|jpn)\b/,
    Korean: /\bkorean\b/,
    Chinese: /\bchinese\b/,
    German: /\b(german|deutsch)\b/,
    French: /\b(french|francais)\b/,
    Italian: /\bitalian\b/,
    Portuguese: /\bportuguese\b/,
  };
  const foundLanguages = Object.entries(languages)
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([name]) => name);
  const grades = [
    ...text.matchAll(
      /\b(PSA|CGC|BGS|SGC)\s*(?:(Gem\s*Mint|Pristine|Perfect|Black\s*Label|Mint)\s*)?(\d+(?:\.\d+)?)(?:\s*\(?\b(OC|MC|ST|PD|OF|MK)\b\)?)?/gi,
    ),
  ].map((match) => ({
    grader: match[1].toUpperCase(),
    number: Number(match[3]),
    label: match[2] ? `${match[2]} ${match[3]}` : `${match[1]} ${match[3]}`,
    qualifier: match[4]?.toUpperCase() ?? null,
  }));
  const graders = [
    ...new Set(
      [...text.matchAll(/\b(PSA|CGC|BGS|SGC)\b/gi)].map((match) =>
        match[1].toUpperCase(),
      ),
    ),
  ];
  const years = [...new Set(text.match(/\b(?:19|20)\d{2}\b/g) ?? [])];
  const cardNumbers = [
    ...new Set(
      [
        ...text.matchAll(
          /\b([A-Z]{1,8}\d{1,4}-\d{1,4}|[A-Z]{0,8}\d{1,4}\/\d{1,4})\b|#\s*([A-Z]{0,8}\d{1,4})\b/gi,
        ),
      ].map((match) => match[1] ?? match[2]),
    ),
  ];
  const stamps = ["shadowless", "staff", "prerelease", "no rarity"].filter(
    (stamp) => ` ${normalized} `.includes(` ${stamp} `),
  );
  const edition = /\b(1st|first)\s*(edition|ed)\b/.test(normalized)
    ? "1st Edition"
    : /\bunlimited\b/.test(normalized)
      ? "Unlimited"
      : null;
  const finish = /\breverse\s*(holo|holographic|foil)\b/.test(normalized)
    ? "Reverse Holo"
    : /\bnon\s*(holo|holographic|foil)\b/.test(normalized)
      ? "Non-Holo"
      : /\b(holo|holographic|foil)\b/.test(normalized)
        ? "Holo"
        : null;
  return {
    languages: foundLanguages,
    grades,
    graders,
    years,
    cardNumbers,
    stamps,
    edition,
    finish,
    bundle:
      /\b(lot|bundle|assorted|mixed|pair of|set of [2-9]|[2-9]\d* (cards|slabs)|[2-9]\d*x)\b/.test(
        normalized,
      ),
    proxy: /\b(proxy|replica|counterfeit)\b/.test(normalized),
    reprint: /\breprint\b/.test(normalized),
    damagedHolder:
      /\b(cracked|damaged|broken|scratched) (slab|case|holder)\b|\b(slab|case|holder) (cracked|damaged|broken|scratched)\b/.test(
        normalized,
      ),
    autograph:
      /\b(signed|autograph|autographed)\b/.test(normalized) &&
      !/\b(not signed|not autographed|no autograph)\b/.test(normalized),
  };
}

export function compareCompIdentity(
  sale: Pick<SaleEvidence, "card" | "grading" | "title" | "extendedTitle">,
  target: SlabIdentity,
): CompReason[] {
  const reasons: CompReason[] = [];
  const conflict = (
    field: string,
    expected: string | number | null,
    actual: string | number | null,
    severity: "review" | "reject" = "reject",
  ) =>
    reasons.push({
      code: `${field}-${severity === "reject" ? "mismatch" : "unresolved"}`,
      field,
      expected,
      actual,
      severity,
    });
  const facts = titleFacts(
    [sale.title, sale.extendedTitle].filter(Boolean).join(" "),
  );
  const title = words(sale.title ?? "");
  const name = words(target.card.name ?? "");
  if (title && name && !` ${title} `.includes(` ${name} `))
    reasons.push({
      code: "card-name-not-established-by-title",
      field: "name",
      expected: target.card.name,
      actual: sale.title,
      severity: "review",
    });
  if (
    title &&
    name &&
    (new RegExp(
      `\\b(?:dark|light|shining|radiant|alolan|galarian|hisuian|paldean|mega|primal) ${name}\\b`,
    ).test(title) ||
      new RegExp(`\\b${name} (?:ex|gx|v|vmax|vstar)\\b`).test(title))
  )
    reasons.push({
      code: "additional-card-variant-in-title",
      severity: "review",
    });
  if (facts.bundle)
    reasons.push({ code: "bundle-not-a-single-slab", severity: "reject" });
  if (facts.proxy)
    reasons.push({ code: "proxy-or-replica", severity: "reject" });
  if (facts.reprint)
    reasons.push({ code: "reprint-requires-review", severity: "review" });
  if (facts.damagedHolder)
    reasons.push({ code: "holder-damage", severity: "review" });
  if (
    facts.graders.length > 1 ||
    new Set(
      facts.grades.map(
        (grade) => `${grade.grader}:${grade.number}:${grade.qualifier}`,
      ),
    ).size > 1
  )
    reasons.push({ code: "multiple-grades-in-title", severity: "review" });
  for (const field of CARD_FIELDS) {
    const expected = target.card[field],
      actual = sale.card?.[field] ?? null;
    if (expected && actual && !sameField(field, expected, actual))
      conflict(field, expected, actual);
    else if (expected && !actual) conflict(field, expected, null, "review");
    else if (
      !expected &&
      (["name", "set", "cardNumber", "language"].includes(field) || actual)
    )
      conflict(field, null, actual, "review");
  }
  // Titles can reveal contradictions, but matching query words cannot establish card identity.
  if (target.card.language)
    for (const language of facts.languages)
      if (!sameField("language", target.card.language, language))
        conflict("language", target.card.language, language);
  if (facts.languages.length > 1)
    reasons.push({ code: "multiple-languages-in-title", severity: "review" });
  if (
    facts.years.length === 1 &&
    target.card.year &&
    facts.years[0] !== target.card.year
  )
    conflict("year", target.card.year, facts.years[0]);
  if (facts.years.length > 1)
    reasons.push({ code: "multiple-years-in-title", severity: "review" });
  for (const number of facts.cardNumbers)
    if (
      target.card.cardNumber &&
      !sameField("cardNumber", target.card.cardNumber, number)
    )
      conflict("title-cardNumber", target.card.cardNumber, number);
  for (const stamp of facts.stamps) {
    if (!target.card.stamp) conflict("stamp", null, stamp, "review");
    else if (!` ${words(target.card.stamp)} `.includes(` ${stamp} `))
      conflict("stamp", target.card.stamp, stamp);
  }
  for (const field of ["edition", "finish"] as const)
    if (
      facts[field] &&
      target.card[field] &&
      !sameField(field, target.card[field]!, facts[field]!)
    )
      conflict(field, target.card[field], facts[field]);
  const grade = facts.grades.length === 1 ? facts.grades[0] : null;
  const grader =
    sale.grading.grader === "UNKNOWN"
      ? (grade?.grader ?? null)
      : sale.grading.grader;
  if (!grader) conflict("grader", target.grading.grader, null, "review");
  else if (grader !== target.grading.grader)
    conflict("grader", target.grading.grader, grader);
  for (const observed of facts.grades) {
    if (
      observed.grader !== target.grading.grader ||
      (target.grading.number !== null &&
        observed.number !== target.grading.number)
    )
      conflict(
        "title-grade",
        `${target.grading.grader} ${target.grading.number}`,
        `${observed.grader} ${observed.number}`,
      );
  }
  const numericGrade = sale.grading.number ?? grade?.number ?? null;
  if (target.grading.number !== null && numericGrade !== target.grading.number)
    conflict(
      "grade",
      target.grading.number,
      numericGrade,
      numericGrade === null ? "review" : "reject",
    );
  if (
    sale.grading.grader !== "UNKNOWN" &&
    sale.grading.number === null &&
    sale.grading.encoding !== "unknown"
  )
    reasons.push({
      code: "provider-grade-encoding-unmapped",
      severity: "review",
    });
  const wantedLabel = gradeLabelKey(
    target.grading.grader,
    target.grading.label,
    target.grading.number,
  );
  for (const observed of facts.grades) {
    const label = gradeLabelKey(
      observed.grader,
      observed.label,
      observed.number,
    );
    if (label && wantedLabel && label !== wantedLabel)
      conflict("title-grade-label", target.grading.label, observed.label);
  }
  const actualLabel = gradeLabelKey(
    grader ?? "UNKNOWN",
    sale.grading.label ?? grade?.label ?? null,
    numericGrade,
  );
  if (!wantedLabel || !actualLabel)
    conflict(
      "grade-label",
      target.grading.label,
      sale.grading.label ?? grade?.label ?? null,
      "review",
    );
  else if (wantedLabel !== actualLabel)
    conflict(
      "grade-label",
      target.grading.label,
      sale.grading.label ?? grade?.label ?? null,
    );
  if (
    grade &&
    gradeLabelKey(grade.grader, grade.label, grade.number) &&
    wantedLabel !== gradeLabelKey(grade.grader, grade.label, grade.number)
  )
    conflict("title-grade-label", target.grading.label, grade.label);
  const labelQualifier = (label: string | null) =>
    /\b(OC|MC|ST|PD|OF|MK)\b/i.exec(label ?? "")?.[1].toUpperCase() ?? null;
  const wantedQualifier =
    target.grading.qualifier ?? labelQualifier(target.grading.label);
  const qualifier =
    sale.grading.qualifier ??
    labelQualifier(sale.grading.label) ??
    grade?.qualifier ??
    null;
  for (const observed of [
    labelQualifier(sale.grading.label),
    ...facts.grades.map((item) => item.qualifier),
  ])
    if (observed && words(observed) !== words(wantedQualifier ?? ""))
      conflict("qualifier", wantedQualifier, observed);
  if (
    (wantedQualifier ? words(wantedQualifier) : null) !==
    (qualifier ? words(qualifier) : null)
  )
    conflict(
      "qualifier",
      wantedQualifier,
      qualifier,
      qualifier === null ? "review" : "reject",
    );
  if (facts.autograph && !target.grading.autograph)
    conflict("autograph", null, "signed");
  if (
    target.grading.autograph &&
    (!sale.grading.autograph ||
      words(sale.grading.autograph) !== words(target.grading.autograph))
  )
    conflict(
      "autograph",
      target.grading.autograph,
      sale.grading.autograph,
      sale.grading.autograph ? "reject" : "review",
    );
  return reasons;
}
