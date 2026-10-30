//! Text in the order JavaScript's `localeCompare` puts it (the ICU root collation the Node app
//! sorts with), for the characters references and names use: punctuation before digits before
//! letters, letters without regard to case first, then lowercase before uppercase. Ties the
//! Node app breaks this way must break the same way here.
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
        // Each pair as `"a".localeCompare("b") < 0` in Node.
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
}
