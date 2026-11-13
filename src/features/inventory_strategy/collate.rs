//! Text in the order JavaScript's `localeCompare` puts it (the ICU root collation), for the
//! characters references and names use: punctuation before digits before letters, letters
//! without regard to case first, then lowercase before uppercase. Saved orders and keys were
//! sorted this way, so ties must break the same way here.
use std::cmp::Ordering;

/// ICU's root order for ASCII punctuation and symbols, before digits and letters.
const PUNCTUATION: &str = "\t\n\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

fn primary(c: char) -> (u32, u32) {
    if let Some(i) = PUNCTUATION.find(c) {
        return (0, i as u32);
    }
    match c {
        '0'..='9' => (1, c as u32),
        'a'..='z' | 'A'..='Z' => (2, c.to_ascii_lowercase() as u32),
        _ => (3, c.to_lowercase().next().unwrap_or(c) as u32),
    }
}

/// `a.localeCompare(b, undefined, { numeric: true })`, the order `Intl.Collator` with
/// `numeric` gives (a sorted table's text, `corten_ui::rows`): as `compare`, but a run of
/// digits against a run of digits compares as the number it writes, so `PSA 9` is before
/// `PSA 10`.
pub fn compare_numeric(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (runs(a), runs(b));
    loop {
        match (x.next(), y.next()) {
            (None, None) => return compare(a, b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(p), Some(q)) => {
                let digits = |s: &str| s.starts_with(|c: char| c.is_ascii_digit());
                let order = if digits(p) && digits(q) {
                    let (p, q) = (p.trim_start_matches('0'), q.trim_start_matches('0'));
                    p.len().cmp(&q.len()).then_with(|| p.cmp(q))
                } else {
                    a_primary(p).cmp(a_primary(q))
                };
                if order != Ordering::Equal {
                    return order;
                }
            }
        }
    }
}

/// The text's runs: each a run of ASCII digits or a run of anything else.
fn runs(text: &str) -> impl Iterator<Item = &str> {
    let mut rest = text;
    std::iter::from_fn(move || {
        let first = rest.chars().next()?;
        let digit = first.is_ascii_digit();
        let end = rest
            .find(|c: char| c.is_ascii_digit() != digit)
            .unwrap_or(rest.len());
        let (run, after) = rest.split_at(end);
        rest = after;
        Some(run)
    })
}

fn a_primary(run: &str) -> impl Iterator<Item = (u32, u32)> + '_ {
    run.chars().map(primary)
}

/// `a.localeCompare(b)` for the text the app sorts.
pub fn compare(a: &str, b: &str) -> Ordering {
    a.chars()
        .map(primary)
        .cmp(b.chars().map(primary))
        // Lowercase sorts before uppercase at the same letters.
        .then_with(|| {
            a.chars()
                .map(|c| c.is_uppercase())
                .cmp(b.chars().map(|c| c.is_uppercase()))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_as_locale_compare_does() {
        // Each pair as `"a".localeCompare("b") < 0` orders it.
        for (a, b) in [
            ("a", "B"),
            ("a", "A"),
            ("pokemon", "YuGiOh"),
            ("purchase:a-1:cost", "purchase:a1:cost"),
            ("9", "a"),
            ("_x", "-x"),
            ("sale:1", "sale:A"),
            ("a_b", "a-b"),
            ("a-b", "ab"),
            ("a b", "a-b"),
            ("x-1", "x:1"),
            ("A1", "a2"),
        ] {
            assert_eq!(compare(a, b), Ordering::Less, "{a} before {b}");
            assert_eq!(compare(b, a), Ordering::Greater, "{b} after {a}");
        }
        assert_eq!(compare("same", "same"), Ordering::Equal);
    }

    #[test]
    fn orders_numbers_in_text_as_a_numeric_collator_does() {
        // Each pair as `new Intl.Collator("en", { numeric: true }).compare(a, b) < 0`.
        for (a, b) in [
            ("PSA 9", "PSA 10"),
            ("Item 2", "Item 10"),
            ("2026-09-30", "2026-10-01"),
            ("a", "B"),
            ("PSA 10", "psa 11"),
            ("x 007", "x 8"),
            ("9", "a"),
            ("Equivalent", "Excluded"),
            ("PSA 9", "PSA 9.5"),
            ("PSA 9.5", "PSA 10"),
            ("BGS 9.5", "PSA 9"),
        ] {
            assert_eq!(compare_numeric(a, b), Ordering::Less, "{a} before {b}");
            assert_eq!(compare_numeric(b, a), Ordering::Greater, "{b} after {a}");
        }
        assert_eq!(compare_numeric("PSA 10", "PSA 10"), Ordering::Equal);
    }
}
