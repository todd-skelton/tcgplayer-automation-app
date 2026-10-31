//! JavaScript's readings of text as a number (`Number`, `Number.parseFloat`,
//! `Number.parseInt`) and its white space, so a field the Node app read from a CSV or a document
//! reads the same here.

/// JavaScript's white space and line terminators (what `trim` removes): Unicode's white space
/// less U+0085, and the byte order mark.
pub fn is_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// `String.prototype.trim`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `Number(text)`: the whole trimmed text as a decimal, a `0x`, `0o` or `0b` integer or
/// `Infinity`; empty text is zero, anything else is NaN.
pub fn number(text: &str) -> f64 {
    let text = trim(text);
    if text.is_empty() {
        return 0.0;
    }
    let radix = match text.get(..2) {
        Some("0x" | "0X") => 16,
        Some("0o" | "0O") => 8,
        Some("0b" | "0B") => 2,
        _ => 10,
    };
    if radix != 10 {
        let digits = &text[2..];
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
            return f64::NAN;
        }
        return digits.chars().fold(0.0, |n, c| {
            n * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
        });
    }
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned == "Infinity" {
        return if text.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    if decimal_length(text) != Some(text.len()) {
        return f64::NAN;
    }
    text.parse().unwrap_or(f64::NAN)
}

/// How long the decimal literal at the start of `text` is (`StrDecimalLiteral`: a sign, digits
/// with a point, then an exponent); none when there is none.
fn decimal_length(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let digits = |from: usize| {
        from + bytes[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let start = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let whole = digits(start);
    let mut end = whole;
    if bytes.get(whole) == Some(&b'.') {
        end = digits(whole + 1);
    }
    if end == start || (end == start + 1 && bytes.get(start) == Some(&b'.')) {
        return None;
    }
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let sign = end + 1 + usize::from(matches!(bytes.get(end + 1), Some(b'+' | b'-')));
        let exponent = digits(sign);
        if exponent > sign {
            end = exponent;
        }
    }
    Some(end)
}

/// `Number.parseFloat`: the longest leading decimal of the trimmed text.
pub fn parse_float(text: &str) -> Option<f64> {
    let text = text.trim_start_matches(is_space);
    let end = decimal_length(text)?;
    text[..end].parse().ok()
}

/// `Number.parseInt(text, 10)`: the leading decimal digits of the trimmed text, with their sign.
pub fn parse_int(text: &str) -> Option<f64> {
    let text = text.trim_start_matches(is_space);
    let (negative, unsigned) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let end = unsigned.bytes().take_while(u8::is_ascii_digit).count();
    let value: f64 = unsigned[..end].parse().ok()?;
    Some(if negative { -value } else { value })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_reads_the_whole_text() {
        assert_eq!(number(" 2231 "), 2231.0);
        assert_eq!(number("0x8B7"), 2231.0);
        assert_eq!(number("2.231e3"), 2231.0);
        assert_eq!(number(""), 0.0);
        assert_eq!(number("\u{a0}"), 0.0);
        assert_eq!(number("-2231"), -2231.0);
        assert_eq!(number("1."), 1.0);
        assert_eq!(number(".5"), 0.5);
        assert_eq!(number("-Infinity"), f64::NEG_INFINITY);
        for nan in [
            "abc", "12abc", "-0x10", "0x", "inf", "NaN", "1e", "1_0", ".", "\u{85}1",
        ] {
            assert!(number(nan).is_nan(), "{nan}");
        }
    }

    #[test]
    fn parse_float_reads_the_leading_decimal() {
        assert_eq!(parse_float("1.25"), Some(1.25));
        assert_eq!(parse_float(" 3 cards"), Some(3.0));
        assert_eq!(parse_float("1e3x"), Some(1000.0));
        assert_eq!(parse_float("2e"), Some(2.0));
        assert_eq!(parse_float("\u{a0}1.5x"), Some(1.5));
        assert_eq!(parse_float("-."), None);
        assert_eq!(parse_float(""), None);
    }

    #[test]
    fn parse_int_reads_the_leading_digits() {
        assert_eq!(parse_int("12abc"), Some(12.0));
        assert_eq!(parse_int(" 7.9"), Some(7.0));
        assert_eq!(parse_int("-4"), Some(-4.0));
        assert_eq!(parse_int("+4"), Some(4.0));
        assert_eq!(parse_int("\u{2003}2"), Some(2.0));
        assert_eq!(parse_int("x"), None);
        assert_eq!(parse_int("-"), None);
    }
}
