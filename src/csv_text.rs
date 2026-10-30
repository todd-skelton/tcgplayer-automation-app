//! CSV as the React screens wrote it with Papa Parse's `unparse`, so a file saved from a ported
//! screen opens as the one saved before: a field quoted when it holds a comma, a quote, a line
//! break, or space at either end, lines ended by CRLF and none after the last.

/// The header and then each row, every row in the header's order.
pub fn unparse(header: &[&str], rows: impl IntoIterator<Item = Vec<String>>) -> String {
    let line =
        |fields: &mut dyn Iterator<Item = &str>| fields.map(field).collect::<Vec<_>>().join(",");
    let mut lines = vec![line(&mut header.iter().copied())];
    for row in rows {
        lines.push(line(&mut row.iter().map(String::as_str)));
    }
    lines.join("\r\n")
}

fn field(text: &str) -> String {
    let quoted =
        text.contains([',', '"', '\n', '\r']) || text.starts_with(' ') || text.ends_with(' ');
    if quoted {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_field_is_quoted_only_when_it_must_be() {
        let csv = unparse(
            &["name", "note"],
            [
                vec!["Ann".to_owned(), "a, \"b\"".to_owned()],
                vec![" pad".to_owned(), String::new()],
            ],
        );
        assert_eq!(csv, "name,note\r\nAnn,\"a, \"\"b\"\"\"\r\n\" pad\",");
    }
}
