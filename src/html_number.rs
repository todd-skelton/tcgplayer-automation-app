//! A number as an HTML number field sends it. The browser sends any valid floating-point number
//! the user typed that is on the field's step, so a whole number may arrive as `3.0` or `1e1`
//! (corten#842).

/// The whole number `text` says, if any: `3`, ` 3 `, `3.0` and `1e1` do; `3.5`, `abc`, empty
/// text and a number past 2^53 do not.
pub fn whole(text: &str) -> Option<i64> {
    const EXACT: f64 = 9_007_199_254_740_992.0;
    let n: f64 = text.trim().parse().ok()?;
    (n.is_finite() && n.fract() == 0.0 && n.abs() <= EXACT).then_some(n as i64)
}

#[cfg(test)]
mod tests {
    use super::whole;

    #[test]
    fn a_whole_number_reads_as_the_browser_sends_it() {
        for (text, n) in [
            ("3", 3),
            (" 3 ", 3),
            ("3.0", 3),
            ("1e1", 10),
            ("-0", 0),
            ("-2", -2),
        ] {
            assert_eq!(whole(text), Some(n), "{text:?}");
        }
        for text in [
            "3.5",
            "abc",
            "",
            "inf",
            "NaN",
            "1e400",
            "9007199254740993.0e1",
        ] {
            assert_eq!(whole(text), None, "{text:?}");
        }
    }
}
