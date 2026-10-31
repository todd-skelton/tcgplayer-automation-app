//! Screening a comparable sale against the slab researched (`screenComparableSale`, with
//! `compareCompIdentity` and `normalizeSalePrice`): accepted, needing review or rejected, and
//! why. Ported from `app/features/ebay-slab-pricing/screening`.
//!
//! The Node app's patterns are JavaScript's without the `u` flag: `\b` and `\d` are ASCII, `\s` is
//! JavaScript's white space and `i` folds ASCII letters only. [`js`] writes them so.
use std::{collections::HashSet, sync::LazyLock};

use chrono::{DateTime, NaiveDate, NaiveDateTime};
use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

use super::research::{Card, Grading, Identity};
use crate::features::inventory_economics::ledger::{assumptions::js_round, fingerprint::js_float};

/// An amount, in the currency the provider gave, if it gave one.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct Money {
    pub amount: f64,
    pub currency: Option<String>,
}

/// One sale saved in an evidence revision (`SaleEvidence`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sale {
    /// `alt` or `ebayResearch`.
    pub provider: String,
    pub provider_id: String,
    pub source_url: Option<String>,
    /// `transaction` or `listing-average`.
    pub kind: String,
    pub date: Option<String>,
    pub format: Option<String>,
    pub title: Option<String>,
    pub extended_title: Option<String>,
    pub card: Option<Card>,
    pub grading: Grading,
    pub price: Option<Money>,
    pub converted_price: Option<Money>,
    pub shipping: Option<Money>,
    pub fees: Option<Money>,
    pub shipping_included: Option<bool>,
    pub buyer_premium_included: Option<bool>,
    pub quantity: Option<f64>,
    pub subject_to_change: Option<bool>,
    pub skipped_reason: Option<String>,
}

/// The operator's decision on a sale (`CompDecision`): `accept` or `exclude`, why, and the item
/// price read from the sale, if any.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub revision_id: String,
    pub provider: String,
    pub provider_id: String,
    pub date: Option<String>,
    pub valuation_group_key: String,
    pub decision: String,
    pub note: String,
    pub item_price: Option<Money>,
}

/// The sale dates an evidence revision was asked for.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct SaleWindow {
    pub from: String,
    pub to: String,
}

/// A sale as saved in a revision (`SaleReference`).
pub struct Reference<'a> {
    pub revision_id: &'a str,
    /// When the revision was fetched, as an ISO time.
    pub fetched_at: &'a str,
    pub window: SaleWindow,
    pub sale: &'a Sale,
}

/// The slab researched: its identity at the grade, whether it is confirmed, and its valuation
/// group.
pub struct Target<'a> {
    pub confirmed: bool,
    pub identity: Option<&'a Identity>,
    pub valuation_group_key: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Review,
    Reject,
}

/// Why a sale is not simply accepted (`CompReason`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reason {
    pub code: String,
    pub severity: Severity,
}

/// How a sale screened: `accepted`, `needs-review` or `rejected`, and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Screened {
    pub status: &'static str,
    pub reasons: Vec<Reason>,
}

fn review(reasons: &mut Vec<Reason>, code: &str) {
    reasons.push(Reason {
        code: code.to_owned(),
        severity: Severity::Review,
    });
}

fn reject(reasons: &mut Vec<Reason>, code: &str) {
    reasons.push(Reason {
        code: code.to_owned(),
        severity: Severity::Reject,
    });
}

/// A field that disagrees (`<field>-mismatch`, rejected) or cannot be told
/// (`<field>-unresolved`, for review).
fn conflict(reasons: &mut Vec<Reason>, field: &str, severity: Severity) {
    let state = match severity {
        Severity::Reject => "mismatch",
        Severity::Review => "unresolved",
    };
    reasons.push(Reason {
        code: format!("{field}-{state}"),
        severity,
    });
}

/// JavaScript's white space, which its `\s` and `trim` take.
const JS_SPACE: &str = r"[\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";

fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\x0B' | '\x0C' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// A JavaScript pattern without the `u` flag: `\b` and `\d` ASCII, `\s` JavaScript's. Its `i`
/// flag is written `(?i-u:...)` around the letters it applies to.
fn js(pattern: &str) -> Regex {
    let pattern = pattern
        .replace(r"\b", r"(?-u:\b)")
        .replace(r"\d", "[0-9]")
        .replace(r"\s", JS_SPACE);
    Regex::new(&pattern).expect("a valid pattern")
}

static MARK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{M}").unwrap());
static NOT_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]+").unwrap());

/// `words`: accents dropped, lower case, and everything but letters and numbers one space.
pub fn words(value: &str) -> String {
    let decomposed: String = value.nfkd().collect();
    let lower = MARK.replace_all(&decomposed, "").to_lowercase();
    NOT_WORD.replace_all(&lower, " ").trim().to_owned()
}

/// A value JavaScript reads as true: given and not empty.
fn filled(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|v| !v.is_empty())
}

/// A card number's parts, each trimmed, lower case and without leading zeros.
fn card_number(value: &str) -> String {
    value
        .strip_prefix('#')
        .unwrap_or(value)
        .split('/')
        .map(|part| {
            let part = part.trim_matches(js_space).to_lowercase();
            let zeros = part.len() - part.trim_start_matches('0').len();
            let before_digit = part[zeros..].starts_with(|c: char| c.is_ascii_digit());
            let cut = if before_digit {
                zeros
            } else {
                zeros.saturating_sub(1)
            };
            part[cut..].to_owned()
        })
        .collect::<Vec<_>>()
        .join("/")
}

static FIRST_EDITION: LazyLock<Regex> = LazyLock::new(|| js(r"^(1st|first)( edition)?$"));

fn normalize_field(field: &str, value: &str) -> String {
    let text = words(value);
    match field {
        "game" if text == "pokemon tcg" => "pokemon".to_owned(),
        "edition" if FIRST_EDITION.is_match(&text) => "1st edition".to_owned(),
        "cardNumber" => card_number(value),
        _ => text,
    }
}

fn same_field(field: &str, a: &str, b: &str) -> bool {
    let first = normalize_field(field, a);
    let second = normalize_field(field, b);
    if field == "cardNumber" && (!first.contains('/') || !second.contains('/')) {
        return first.split('/').next() == second.split('/').next();
    }
    first == second
}

static LABEL_NUMBER: LazyLock<Regex> = LazyLock::new(|| js(r"\d+(?:\.\d+)?"));
static GRADER_PREFIX: LazyLock<Regex> = LazyLock::new(|| js(r"^(psa|cgc|bgs|sgc)\s*"));
static GRADE_NUMBERS: LazyLock<Regex> = LazyLock::new(|| js(r"\b\d+(?:\s\d+)?\b"));
static QUALIFIER_WORDS: LazyLock<Regex> = LazyLock::new(|| js(r"\b(oc|mc|st|pd|of|mk)\b"));
static BLACK_LABEL: LazyLock<Regex> = LazyLock::new(|| js(r"\bblack label\b"));
static PRISTINE: LazyLock<Regex> = LazyLock::new(|| js(r"\bpristine\b"));
static PERFECT: LazyLock<Regex> = LazyLock::new(|| js(r"\bperfect\b"));
static GEM_MINT: LazyLock<Regex> = LazyLock::new(|| js(r"\bgem mint\b"));
static ONLY_NUMBERS: LazyLock<Regex> = LazyLock::new(|| js(r"^[\d\s]+$"));

/// PSA's standard descriptors of each grade.
fn psa_descriptors(grade: &str) -> &'static [&'static str] {
    match grade {
        "1" => &["poor", "pr"],
        "2" => &["good", "gd"],
        "3" => &["very good", "vg"],
        "4" => &["vg ex", "very good excellent"],
        "5" => &["excellent", "ex"],
        "6" => &["ex mt", "excellent mint"],
        "7" => &["near mint", "nm"],
        "8" => &["nm mt", "near mint mint"],
        "9" => &["mint", "mt"],
        "10" => &["gem mint", "gem mt"],
        _ => &[],
    }
}

/// `gradeLabelKey`: what a grader's label means, so two ways of writing it compare equal.
pub fn grade_label_key(grader: &str, label: Option<&str>, number: Option<f64>) -> Option<String> {
    let label = label.filter(|l| !l.is_empty())?;
    if let Some(number) = number
        && LABEL_NUMBER
            .find_iter(label)
            .any(|m| m.as_str().parse::<f64>().ok() != Some(number))
    {
        return Some(format!("{grader}:inconsistent:{}", words(label)));
    }
    let shown = number.map_or_else(|| "null".to_owned(), js_float);
    let text = GRADER_PREFIX
        .replace(&words(label), "")
        .trim_matches(js_space)
        .to_owned();
    if grader == "PSA" && number.is_some() {
        let numbers = GRADE_NUMBERS.replace_all(&text, "");
        let descriptor = QUALIFIER_WORDS.replace_all(&numbers, "");
        let descriptor = descriptor.trim_matches(js_space);
        if descriptor.is_empty() || psa_descriptors(&shown).contains(&descriptor) {
            return Some(format!("PSA:{shown}"));
        }
    }
    if matches!(grader, "CGC" | "BGS" | "SGC") {
        for (pattern, name) in [
            (&BLACK_LABEL, "black-label"),
            (&PRISTINE, "pristine"),
            (&PERFECT, "perfect"),
            (&GEM_MINT, "gem-mint"),
        ] {
            if pattern.is_match(&text) {
                return Some(format!("{grader}:{name}:{shown}"));
            }
        }
        // A CGC 10 alone is not a Gem Mint or Pristine label.
        if ONLY_NUMBERS.is_match(&text) {
            return None;
        }
    }
    Some(format!("{grader}:{text}"))
}

/// A grade written in a title.
#[derive(Clone, Debug, PartialEq)]
struct TitleGrade {
    grader: String,
    number: f64,
    label: String,
    qualifier: Option<String>,
}

impl TitleGrade {
    fn read(m: &Captures<'_>) -> TitleGrade {
        let number = &m[3];
        let named = m.get(2).map_or(&m[1], |label| label.as_str());
        TitleGrade {
            grader: m[1].to_ascii_uppercase(),
            number: number.parse().expect("digits"),
            label: format!("{named} {number}"),
            qualifier: m.get(4).map(|q| q.as_str().to_ascii_uppercase()),
        }
    }

    fn label_key(&self) -> Option<String> {
        grade_label_key(&self.grader, Some(&self.label), Some(self.number))
    }
}

/// `titleFacts`: what a title says about the card and grade.
#[derive(Debug, Default, PartialEq)]
struct Facts {
    languages: Vec<&'static str>,
    grades: Vec<TitleGrade>,
    graders: Vec<String>,
    years: Vec<String>,
    card_numbers: Vec<String>,
    stamps: Vec<&'static str>,
    edition: Option<&'static str>,
    finish: Option<&'static str>,
    bundle: bool,
    proxy: bool,
    reprint: bool,
    damaged_holder: bool,
    autograph: bool,
}

static LANGUAGES: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    [
        ("English", r"\benglish\b"),
        ("Spanish", r"\b(spanish|espanol)\b"),
        ("Japanese", r"\b(japanese|jpn)\b"),
        ("Korean", r"\bkorean\b"),
        ("Chinese", r"\bchinese\b"),
        ("German", r"\b(german|deutsch)\b"),
        ("French", r"\b(french|francais)\b"),
        ("Italian", r"\bitalian\b"),
        ("Portuguese", r"\bportuguese\b"),
    ]
    .into_iter()
    .map(|(name, pattern)| (name, js(pattern)))
    .collect()
});
static TITLE_GRADE: LazyLock<Regex> = LazyLock::new(|| {
    js(
        r"\b((?i-u:PSA|CGC|BGS|SGC))\s*(?:((?i-u:Gem)\s*(?i-u:Mint)|(?i-u:Pristine)|(?i-u:Perfect)|(?i-u:Black)\s*(?i-u:Label)|(?i-u:Mint))\s*)?(\d+(?:\.\d+)?)(?:\s*\(?\b((?i-u:OC|MC|ST|PD|OF|MK))\b\)?)?",
    )
});
static GRADER: LazyLock<Regex> = LazyLock::new(|| js(r"\b((?i-u:PSA|CGC|BGS|SGC))\b"));
static YEAR: LazyLock<Regex> = LazyLock::new(|| js(r"\b(?:19|20)\d{2}\b"));
static CARD_NUMBER: LazyLock<Regex> = LazyLock::new(|| {
    js(
        r"\b((?i-u:[A-Z]){1,8}\d{1,4}-\d{1,4}|(?i-u:[A-Z]){0,8}\d{1,4}/\d{1,4})\b|#\s*((?i-u:[A-Z]){0,8}\d{1,4})\b",
    )
});
static EDITION: LazyLock<Regex> = LazyLock::new(|| js(r"\b(1st|first)\s*(edition|ed)\b"));
static UNLIMITED: LazyLock<Regex> = LazyLock::new(|| js(r"\bunlimited\b"));
static REVERSE_HOLO: LazyLock<Regex> =
    LazyLock::new(|| js(r"\breverse\s*(holo|holographic|foil)\b"));
static NON_HOLO: LazyLock<Regex> = LazyLock::new(|| js(r"\bnon\s*(holo|holographic|foil)\b"));
static HOLO: LazyLock<Regex> = LazyLock::new(|| js(r"\b(holo|holographic|foil)\b"));
static BUNDLE: LazyLock<Regex> = LazyLock::new(|| {
    js(r"\b(lot|bundle|assorted|mixed|pair of|set of [2-9]|[2-9]\d* (cards|slabs)|[2-9]\d*x)\b")
});
static PROXY: LazyLock<Regex> = LazyLock::new(|| js(r"\b(proxy|replica|counterfeit)\b"));
static REPRINT: LazyLock<Regex> = LazyLock::new(|| js(r"\breprint\b"));
static DAMAGED_HOLDER: LazyLock<Regex> = LazyLock::new(|| {
    js(
        r"\b(cracked|damaged|broken|scratched) (slab|case|holder)\b|\b(slab|case|holder) (cracked|damaged|broken|scratched)\b",
    )
});
static SIGNED: LazyLock<Regex> = LazyLock::new(|| js(r"\b(signed|autograph|autographed)\b"));
static NOT_SIGNED: LazyLock<Regex> =
    LazyLock::new(|| js(r"\b(not signed|not autographed|no autograph)\b"));
static QUALIFIER: LazyLock<Regex> = LazyLock::new(|| js(r"\b((?i-u:OC|MC|ST|PD|OF|MK))\b"));
static OUTCOME_UNKNOWN: LazyLock<Regex> =
    LazyLock::new(|| js(r"\b((?i-u:active|open|unsold|cancelled|canceled))\b"));
static ISO_DAY: LazyLock<Regex> = LazyLock::new(|| js(r"^\d{4}-\d{2}-\d{2}$"));

/// Each distinct value, in the order first seen.
fn distinct(found: impl Iterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    found.filter(|f| seen.insert(f.clone())).collect()
}

fn title_facts(text: &str) -> Facts {
    let normalized = words(text);
    let spaced = format!(" {normalized} ");
    let first = |patterns: &[(&Regex, &'static str)]| {
        patterns
            .iter()
            .find(|(pattern, _)| pattern.is_match(&normalized))
            .map(|(_, value)| *value)
    };
    Facts {
        languages: LANGUAGES
            .iter()
            .filter(|(_, pattern)| pattern.is_match(&normalized))
            .map(|(name, _)| *name)
            .collect(),
        grades: TITLE_GRADE
            .captures_iter(text)
            .map(|m| TitleGrade::read(&m))
            .collect(),
        graders: distinct(
            GRADER
                .captures_iter(text)
                .map(|m| m[1].to_ascii_uppercase()),
        ),
        years: distinct(YEAR.find_iter(text).map(|m| m.as_str().to_owned())),
        card_numbers: distinct(CARD_NUMBER.captures_iter(text).map(|m| {
            m.get(1)
                .or_else(|| m.get(2))
                .map_or("", |n| n.as_str())
                .to_owned()
        })),
        stamps: ["shadowless", "staff", "prerelease", "no rarity"]
            .into_iter()
            .filter(|stamp| spaced.contains(&format!(" {stamp} ")))
            .collect(),
        edition: first(&[(&EDITION, "1st Edition"), (&UNLIMITED, "Unlimited")]),
        finish: first(&[
            (&REVERSE_HOLO, "Reverse Holo"),
            (&NON_HOLO, "Non-Holo"),
            (&HOLO, "Holo"),
        ]),
        bundle: BUNDLE.is_match(&normalized),
        proxy: PROXY.is_match(&normalized),
        reprint: REPRINT.is_match(&normalized),
        damaged_holder: DAMAGED_HOLDER.is_match(&normalized),
        autograph: SIGNED.is_match(&normalized) && !NOT_SIGNED.is_match(&normalized),
    }
}

/// The card's fields (`CARD_FIELDS`), in their order, those JavaScript reads as given.
fn card_fields(card: Option<&Card>) -> [(&'static str, Option<&str>); 9] {
    let field = |read: fn(&Card) -> &Option<String>| card.and_then(|c| filled(read(c)));
    [
        ("name", field(|c| &c.name)),
        ("game", field(|c| &c.game)),
        ("language", field(|c| &c.language)),
        ("set", field(|c| &c.set)),
        ("cardNumber", field(|c| &c.card_number)),
        ("year", field(|c| &c.year)),
        ("edition", field(|c| &c.edition)),
        ("finish", field(|c| &c.finish)),
        ("stamp", field(|c| &c.stamp)),
    ]
}

fn label_qualifier(label: Option<&str>) -> Option<String> {
    QUALIFIER
        .captures(label.unwrap_or(""))
        .map(|m| m[1].to_ascii_uppercase())
}

/// `compareCompIdentity`: where the sale's card and grade disagree with the target's, or cannot
/// be told.
fn compare_identity(sale: &Sale, target: &Identity) -> Vec<Reason> {
    use Severity::{Reject, Review};
    let mut reasons = Vec::new();
    let r = &mut reasons;
    let joined = [&sale.title, &sale.extended_title]
        .into_iter()
        .filter_map(filled)
        .collect::<Vec<_>>()
        .join(" ");
    let facts = title_facts(&joined);
    let title = words(sale.title.as_deref().unwrap_or(""));
    let card = &target.card;
    let wanted = &target.grading;
    let name = words(card.name.as_deref().unwrap_or(""));
    if !title.is_empty() && !name.is_empty() {
        if !format!(" {title} ").contains(&format!(" {name} ")) {
            review(r, "card-name-not-established-by-title");
        }
        let name = regex::escape(&name);
        let variant = js(&format!(
            r"\b(?:dark|light|shining|radiant|alolan|galarian|hisuian|paldean|mega|primal) {name}\b"
        ));
        let suffix = js(&format!(r"\b{name} (?:ex|gx|v|vmax|vstar)\b"));
        if variant.is_match(&title) || suffix.is_match(&title) {
            review(r, "additional-card-variant-in-title");
        }
    }
    if facts.bundle {
        reject(r, "bundle-not-a-single-slab");
    }
    if facts.proxy {
        reject(r, "proxy-or-replica");
    }
    if facts.reprint {
        review(r, "reprint-requires-review");
    }
    if facts.damaged_holder {
        review(r, "holder-damage");
    }
    let title_grades: HashSet<(&str, u64, Option<&str>)> = facts
        .grades
        .iter()
        .map(|g| {
            (
                g.grader.as_str(),
                g.number.to_bits(),
                g.qualifier.as_deref(),
            )
        })
        .collect();
    if facts.graders.len() > 1 || title_grades.len() > 1 {
        review(r, "multiple-grades-in-title");
    }
    for ((field, expected), (_, actual)) in card_fields(Some(card))
        .into_iter()
        .zip(card_fields(sale.card.as_ref()))
    {
        match (expected, actual) {
            (Some(e), Some(a)) if !same_field(field, e, a) => conflict(r, field, Reject),
            (Some(_), Some(_)) => {}
            (Some(_), None) => conflict(r, field, Review),
            (None, actual) => {
                if ["name", "set", "cardNumber", "language"].contains(&field) || actual.is_some() {
                    conflict(r, field, Review);
                }
            }
        }
    }
    // Titles can reveal contradictions, but matching query words cannot establish card identity.
    if let Some(language) = filled(&card.language) {
        for found in &facts.languages {
            if !same_field("language", language, found) {
                conflict(r, "language", Reject);
            }
        }
    }
    if facts.languages.len() > 1 {
        review(r, "multiple-languages-in-title");
    }
    if let ([year], Some(expected)) = (facts.years.as_slice(), filled(&card.year))
        && year != expected
    {
        conflict(r, "year", Reject);
    }
    if facts.years.len() > 1 {
        review(r, "multiple-years-in-title");
    }
    if let Some(expected) = filled(&card.card_number) {
        for number in &facts.card_numbers {
            if !same_field("cardNumber", expected, number) {
                conflict(r, "title-cardNumber", Reject);
            }
        }
    }
    for stamp in &facts.stamps {
        match filled(&card.stamp) {
            None => conflict(r, "stamp", Review),
            Some(expected) if !format!(" {} ", words(expected)).contains(&format!(" {stamp} ")) => {
                conflict(r, "stamp", Reject)
            }
            Some(_) => {}
        }
    }
    for (field, found, expected) in [
        ("edition", facts.edition, filled(&card.edition)),
        ("finish", facts.finish, filled(&card.finish)),
    ] {
        if let (Some(found), Some(expected)) = (found, expected)
            && !same_field(field, expected, found)
        {
            conflict(r, field, Reject);
        }
    }
    let grade = match facts.grades.as_slice() {
        [only] => Some(only),
        _ => None,
    };
    let grader = if sale.grading.grader == "UNKNOWN" {
        grade.map(|g| g.grader.clone())
    } else {
        Some(sale.grading.grader.clone())
    };
    match filled(&grader) {
        None => conflict(r, "grader", Review),
        Some(grader) if grader != wanted.grader => conflict(r, "grader", Reject),
        Some(_) => {}
    }
    for observed in &facts.grades {
        if observed.grader != wanted.grader || wanted.number.is_some_and(|n| observed.number != n) {
            conflict(r, "title-grade", Reject);
        }
    }
    let numeric = sale.grading.number.or(grade.map(|g| g.number));
    if wanted.number.is_some() && numeric != wanted.number {
        conflict(r, "grade", if numeric.is_none() { Review } else { Reject });
    }
    if sale.grading.grader != "UNKNOWN"
        && sale.grading.number.is_none()
        && sale.grading.encoding != "unknown"
    {
        review(r, "provider-grade-encoding-unmapped");
    }
    let wanted_label = grade_label_key(&wanted.grader, wanted.label.as_deref(), wanted.number);
    for observed in &facts.grades {
        if let (Some(label), Some(wanted)) = (observed.label_key(), &wanted_label)
            && &label != wanted
        {
            conflict(r, "title-grade-label", Reject);
        }
    }
    let sale_label = sale
        .grading
        .label
        .as_deref()
        .or(grade.map(|g| g.label.as_str()));
    let actual_label = grade_label_key(grader.as_deref().unwrap_or("UNKNOWN"), sale_label, numeric);
    match (&wanted_label, &actual_label) {
        (Some(w), Some(a)) if w != a => conflict(r, "grade-label", Reject),
        (Some(_), Some(_)) => {}
        _ => conflict(r, "grade-label", Review),
    }
    if let Some(key) = grade.and_then(TitleGrade::label_key)
        && wanted_label.as_ref() != Some(&key)
    {
        conflict(r, "title-grade-label", Reject);
    }
    let wanted_qualifier = wanted
        .qualifier
        .clone()
        .or_else(|| label_qualifier(wanted.label.as_deref()));
    let qualifier = sale
        .grading
        .qualifier
        .clone()
        .or_else(|| label_qualifier(sale.grading.label.as_deref()))
        .or_else(|| grade.and_then(|g| g.qualifier.clone()));
    let wanted_words = words(wanted_qualifier.as_deref().unwrap_or(""));
    let observed = std::iter::once(label_qualifier(sale.grading.label.as_deref()))
        .chain(facts.grades.iter().map(|g| g.qualifier.clone()));
    for found in observed.flatten() {
        if !found.is_empty() && words(&found) != wanted_words {
            conflict(r, "qualifier", Reject);
        }
    }
    if filled(&wanted_qualifier).map(words) != filled(&qualifier).map(words) {
        let severity = if qualifier.is_none() { Review } else { Reject };
        conflict(r, "qualifier", severity);
    }
    if facts.autograph && filled(&wanted.autograph).is_none() {
        conflict(r, "autograph", Reject);
    }
    if let Some(expected) = filled(&wanted.autograph) {
        match filled(&sale.grading.autograph) {
            None => conflict(r, "autograph", Review),
            Some(signed) if words(signed) != words(expected) => conflict(r, "autograph", Reject),
            Some(_) => {}
        }
    }
    reasons
}

/// A sale's item price in the currency screened (`normalizeSalePrice` without a conversion), and
/// why its parts cannot be told.
struct Price {
    item_only: Option<f64>,
    reasons: Vec<&'static str>,
}

fn valid(money: &Money) -> bool {
    money.amount.is_finite() && money.amount >= 0.0 && money.amount < 1e9
}

fn rounded(amount: f64) -> f64 {
    js_round(amount * 1e8) as f64 / 1e8
}

/// Converted amounts reported by a provider are kept; no exchange rate is invented.
fn sale_price(sale: &Sale, currency: &str) -> Price {
    let mut reasons: Vec<&'static str> = Vec::new();
    let mut add = |reason: &'static str| {
        if !reasons.contains(&reason) {
            reasons.push(reason);
        }
    };
    let convert = |money: &Option<Money>| -> Option<f64> {
        money
            .as_ref()
            .filter(|m| valid(m) && m.currency.as_deref() == Some(currency))
            .map(|m| m.amount)
    };
    let mut reported = convert(&sale.price);
    let unpriced = sale
        .price
        .as_ref()
        .is_none_or(|p| filled(&p.currency).is_none());
    if reported.is_none()
        && unpriced
        && let Some(converted) = sale
            .converted_price
            .as_ref()
            .filter(|c| valid(c) && c.currency.as_deref() == Some(currency))
    {
        match &sale.price {
            Some(price) if valid(price) && price.amount != converted.amount => {
                add("provider-conversion-disagrees-with-reported-price")
            }
            _ => {
                reported = Some(converted.amount);
                add("provider-reported-conversion");
            }
        }
    }
    if reported.is_none() {
        add("price-currency-unresolved");
    }
    let shipping = convert(&sale.shipping);
    let fees = convert(&sale.fees);
    let mut item_only = reported;
    match sale.shipping_included {
        None => {
            item_only = None;
            add("shipping-inclusion-unknown");
        }
        Some(true) => item_only = reported.zip(shipping).map(|(r, s)| rounded(r - s)),
        Some(false) => {}
    }
    match sale.buyer_premium_included {
        Some(true) => item_only = item_only.zip(fees).map(|(i, f)| rounded(i - f)),
        None => {
            item_only = None;
            add("buyer-premium-inclusion-unknown");
        }
        Some(false) => {}
    }
    if sale.kind == "transaction" && sale.quantity.is_some_and(|q| q != 1.0) {
        item_only = None;
        add("transaction-quantity-price-basis-unresolved");
    }
    if item_only.is_some_and(|i| i <= 0.0) {
        item_only = None;
        add("nonpositive-item-price");
    }
    if shipping.is_none() {
        add("shipping-unknown");
    }
    if fees.is_none() {
        add("buyer-fees-unknown");
    }
    Price { item_only, reasons }
}

/// `Date.parse` of an ISO time: whether it reads as one.
fn is_time(value: &str) -> bool {
    DateTime::parse_from_rfc3339(value).is_ok()
        || NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f").is_ok()
        || NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}

/// A real calendar day, written `YYYY-MM-DD`.
fn is_day(value: &str) -> bool {
    ISO_DAY.is_match(value)
        && NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .is_ok_and(|d| d.format("%Y-%m-%d").to_string() == value)
}

/// `screenComparableSale`: the sale against the target, with the operator's decision on it.
pub fn screen(
    reference: &Reference<'_>,
    target: &Target<'_>,
    currency: &str,
    supplied: Option<&Decision>,
) -> Screened {
    let sale = reference.sale;
    let mut reasons = match target.identity {
        Some(identity) if target.confirmed => compare_identity(sale, identity),
        _ => vec![Reason {
            code: "target-identity-unconfirmed".to_owned(),
            severity: Severity::Review,
        }],
    };
    let r = &mut reasons;
    let price = sale_price(sale, currency);
    let date = sale.date.as_deref().filter(|d| is_day(d));
    match date {
        None => review(r, "sale-date-unresolved"),
        Some(day) if day < reference.window.from.as_str() || day > reference.window.to.as_str() => {
            reject(r, "outside-evidence-window")
        }
        Some(_) => {}
    }
    let fetched_day: String = reference.fetched_at.chars().take(10).collect();
    let unknown_outcome = !is_time(reference.fetched_at)
        || date.is_some_and(|d| d > fetched_day.as_str())
        || sale.subject_to_change == Some(true)
        || filled(&sale.format).is_none_or(|f| OUTCOME_UNKNOWN.is_match(f));
    if unknown_outcome {
        review(r, "sale-outcome-unconfirmed");
    }
    if filled(&sale.skipped_reason).is_some() {
        review(r, "provider-skipped-sale");
    }
    if sale.kind == "listing-average" && sale.quantity != Some(1.0) {
        review(r, "grouped-average-not-an-individual-sale");
    }
    if price.item_only.is_none() {
        review(r, "item-price-unresolved");
    }
    for code in &price.reasons {
        review(r, code);
    }
    let decision = supplied.filter(|d| {
        d.revision_id == reference.revision_id
            && d.provider == sale.provider
            && d.provider_id == sale.provider_id
            && d.date == sale.date
            && Some(d.valuation_group_key.as_str()) == target.valuation_group_key
            && !d.note.trim_matches(js_space).is_empty()
    });
    if supplied.is_some() && decision.is_none() {
        review(r, "comp-decision-is-stale");
    }
    if decision.is_some_and(|d| d.decision == "exclude") {
        reject(r, "excluded-by-review");
    }
    let accepted = decision.filter(|d| d.decision == "accept");
    // A reviewed item amount is explicit input, not a guess that unknown fees or shipping are zero.
    let reviewed_price = accepted
        .and_then(|d| d.item_price.as_ref())
        .filter(|p| {
            p.currency.as_deref() == Some(currency)
                && p.amount.is_finite()
                && p.amount > 0.0
                && p.amount < 1e9
        })
        .map(|p| p.amount);
    let item_only = reviewed_price.or(price.item_only);
    let wrong_currency = decision
        .and_then(|d| d.item_price.as_ref())
        .is_some_and(|p| p.currency.as_deref() != Some(currency));
    if wrong_currency {
        review(r, "reviewed-price-currency-mismatch");
    }
    let hard_reject = reasons.iter().any(|r| r.severity == Severity::Reject);
    let reviewed = accepted.is_some()
        && target.confirmed
        && target.identity.is_some()
        && date.is_some()
        && !unknown_outcome
        && !wrong_currency
        && item_only.is_some();
    let status = if hard_reject {
        "rejected"
    } else if reviewed || reasons.is_empty() {
        "accepted"
    } else {
        "needs-review"
    };
    Screened { status, reasons }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    #[test]
    fn words_and_labels_read_as_the_node_app_reads_them() {
        assert_eq!(words("  Pokémon—Trainer!! "), "pokemon trainer");
        assert_eq!(words("ＰＳＡ ①"), "psa 1");
        assert_eq!(card_number("#053/064"), "53/64");
        assert_eq!(card_number("00a/000"), "0a/0");
        let key = |grader, label, number| grade_label_key(grader, Some(label), number);
        assert_eq!(
            key("PSA", "GEM MT 10", Some(10.0)).as_deref(),
            Some("PSA:10")
        );
        assert_eq!(
            key("PSA", "PSA 10", Some(9.0)).as_deref(),
            Some("PSA:inconsistent:psa 10")
        );
        assert_eq!(key("CGC", "10", Some(10.0)), None);
        assert_eq!(
            key("CGC", "Pristine 10", None).as_deref(),
            Some("CGC:pristine:null")
        );
        let facts = title_facts("Goldeen PSA 1 (MK) 1999 #53 \u{212A}53/64 \u{17F}1/2");
        assert_eq!(facts.grades[0].qualifier.as_deref(), Some("MK"));
        assert_eq!(
            facts.card_numbers,
            ["53", "53/64", "1/2"],
            "only ASCII letters fold"
        );
    }

    /// Node's `screenComparableSale` over the corpus `.port-logs/screening-node.ts` builds
    /// (targets, titles, grades, cards, prices, dates and decisions), each sale's status and
    /// reasons recorded.
    #[test]
    #[ignore = "reads Node's screenings in .port-logs"]
    fn sales_screen_as_node_screens_them() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Saved {
            revision_id: String,
            fetched_at: String,
            window: SaleWindow,
            sale: Sale,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Researched {
            status: String,
            identity: Option<Identity>,
            valuation_group_key: Option<String>,
        }
        #[derive(Deserialize)]
        struct Case {
            reference: Saved,
            target: Researched,
            decision: Option<Decision>,
            status: String,
            reasons: Vec<(String, String)>,
        }
        let text = std::fs::read_to_string(".port-logs/screening.node.json").unwrap();
        let cases: Vec<Value> = serde_json::from_str(&text).unwrap();
        assert!(cases.len() > 3000);
        let mut failed = Vec::new();
        for (i, case) in cases.into_iter().enumerate() {
            let shown = case.to_string();
            let case: Case = serde_json::from_value(case).unwrap();
            let reference = Reference {
                revision_id: &case.reference.revision_id,
                fetched_at: &case.reference.fetched_at,
                window: case.reference.window.clone(),
                sale: &case.reference.sale,
            };
            let target = Target {
                confirmed: case.target.status == "confirmed",
                identity: case.target.identity.as_ref(),
                valuation_group_key: case.target.valuation_group_key.as_deref(),
            };
            let ours = screen(&reference, &target, "USD", case.decision.as_ref());
            let reasons: Vec<(String, String)> = ours
                .reasons
                .iter()
                .map(|r| {
                    let severity = match r.severity {
                        Severity::Review => "review",
                        Severity::Reject => "reject",
                    };
                    (r.code.clone(), severity.to_owned())
                })
                .collect();
            if (ours.status, &reasons) != (case.status.as_str(), &case.reasons) {
                failed.push(format!(
                    "case {i}: ours {} {reasons:?}\n  theirs {} {:?}\n  {}",
                    ours.status,
                    case.status,
                    case.reasons,
                    &shown[..shown.len().min(700)]
                ));
            }
        }
        let shown: Vec<String> = failed.iter().take(6).cloned().collect();
        assert!(
            failed.is_empty(),
            "{} differ:\n{}",
            failed.len(),
            shown.join("\n")
        );
    }
}
