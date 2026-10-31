//! CSV as the React screens read and wrote it with Papa Parse. Written (`unparse`) so a file saved
//! from a ported screen opens as the one saved before: a field quoted when it holds a comma, a
//! quote, a line break, or space at either end, lines ended by CRLF and none after the last. Read
//! (`parse`) so an upload reads to the rows the Node app read from it: the line break and the
//! delimiter guessed as Papa Parse 5.7 guesses them, and a malformed quote read as it reads it.
use serde_json::{Map, Value};

use crate::js_number;

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

/// An uploaded file's text as `File.text()` decodes it: UTF-8, a malformed sequence replaced,
/// one byte order mark dropped.
pub fn decode(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned()
}

/// `Papa.parse(text, { header: true, skipEmptyLines: true }).data`: each row after the header
/// as an object of its fields by the header's names, a repeated name numbered (`Name_1`), fields
/// past the header's in `__parsed_extra`, and a short row without the missing names.
pub fn parse(text: &str) -> Vec<Map<String, Value>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let newline = guess_newline(text);
    let delimiter = guess_delimiter(text, newline).unwrap_or(",");
    let mut rows = Parser {
        delimiter,
        newline,
        preview: None,
    }
    .rows(text);
    if let Some(header) = rows.first_mut() {
        rename_repeated(header);
    }
    rows.retain(|row| !empty_line(row));
    let mut rows = rows.into_iter();
    let Some(fields) = rows.next() else {
        return Vec::new();
    };
    rows.map(|row| {
        let mut object = Map::new();
        let mut extra = Vec::new();
        for (i, value) in row.into_iter().enumerate() {
            match fields.get(i) {
                Some(name) => {
                    object.insert(name.clone(), Value::String(value));
                }
                None => extra.push(Value::String(value)),
            }
        }
        if !extra.is_empty() {
            object.insert("__parsed_extra".to_owned(), Value::Array(extra));
        }
        object
    })
    .collect()
}

/// `skipEmptyLines: true`: a line with one empty field.
fn empty_line(row: &[String]) -> bool {
    matches!(row, [only] if only.is_empty())
}

/// The header's repeated names numbered, each number not already a name.
fn rename_repeated(header: &mut [String]) {
    let mut used: std::collections::HashSet<String> = header.iter().cloned().collect();
    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for field in header.iter_mut() {
        let name = field.strip_prefix('\u{feff}').unwrap_or(field).to_owned();
        match counts.get(&name).copied() {
            None => {
                counts.insert(name.clone(), 1);
                *field = name.clone();
            }
            Some(count) => {
                let mut suffix = count;
                let renamed = loop {
                    let candidate = format!("{name}_{suffix}");
                    suffix += 1;
                    if !used.contains(&candidate) {
                        break candidate;
                    }
                };
                used.insert(renamed.clone());
                *field = renamed;
                counts.insert(name.clone(), count + 1);
            }
        }
        used.insert(name);
    }
}

/// `guessLineEndings`: with quoted text set aside in the first million characters, `\n` unless
/// a `\r` comes first, then `\r\n` when at least half the `\r`s are followed by `\n`.
fn guess_newline(text: &str) -> &'static str {
    let head = match text.char_indices().nth(1 << 20) {
        Some((at, _)) => &text[..at],
        None => text,
    };
    let mut unquoted = String::with_capacity(head.len());
    let mut rest = head;
    while let Some(open) = rest.find('"') {
        match rest[open + 1..].find('"') {
            Some(close) => {
                unquoted.push_str(&rest[..open]);
                rest = &rest[open + 1 + close + 1..];
            }
            None => break,
        }
    }
    unquoted.push_str(rest);
    let by_return: Vec<&str> = unquoted.split('\r').collect();
    let by_newline: Vec<&str> = unquoted.split('\n').collect();
    let newline_first = by_newline.len() > 1 && by_newline[0].len() < by_return[0].len();
    if by_return.len() == 1 || newline_first {
        return "\n";
    }
    let followed = by_return.iter().filter(|s| s.starts_with('\n')).count();
    if followed as f64 >= by_return.len() as f64 / 2.0 {
        "\r\n"
    } else {
        "\r"
    }
}

/// `guessDelimiter`: of comma, tab, bar, semicolon and the record and unit separators, the one
/// that splits the first ten lines most evenly into two or more fields on average, the most
/// fields among equals; none when no delimiter does.
fn guess_delimiter(text: &str, newline: &'static str) -> Option<&'static str> {
    let mut best: Option<(&'static str, f64, f64)> = None;
    for delimiter in [",", "\t", "|", ";", "\u{1e}", "\u{1f}"] {
        let rows = Parser {
            delimiter,
            newline,
            preview: Some(10),
        }
        .rows(text);
        let (mut delta, mut fields, mut empty) = (0.0, 0.0, 0.0);
        let mut previous: Option<usize> = None;
        for row in &rows {
            if empty_line(row) {
                empty += 1.0;
                continue;
            }
            fields += row.len() as f64;
            match previous {
                None => previous = Some(row.len()),
                Some(count) => {
                    delta += (row.len() as f64 - count as f64).abs();
                    previous = Some(row.len());
                }
            }
        }
        if !rows.is_empty() {
            fields /= rows.len() as f64 - empty;
        }
        let better = match best {
            None => true,
            Some((_, best_delta, best_fields)) => {
                delta < best_delta || (delta == best_delta && fields > best_fields)
            }
        };
        if fields > 1.99 && better {
            best = Some((delimiter, delta, fields));
        }
    }
    best.map(|(delimiter, _, _)| delimiter)
}

/// Papa Parse's `Parser` with `"` quoting: rows of fields, at most `preview` of them.
struct Parser {
    delimiter: &'static str,
    newline: &'static str,
    preview: Option<usize>,
}

impl Parser {
    fn rows(&self, input: &str) -> Vec<Vec<String>> {
        Scan {
            input,
            delimiter: self.delimiter,
            newline: self.newline,
            preview: self.preview,
            cursor: 0,
            rows: Vec::new(),
            row: Vec::new(),
        }
        .run()
    }
}

/// One pass of [`Parser`] over `input`, kept to the original's positions: `-1` is "not found".
struct Scan<'a> {
    input: &'a str,
    delimiter: &'a str,
    newline: &'a str,
    preview: Option<usize>,
    cursor: isize,
    rows: Vec<Vec<String>>,
    row: Vec<String>,
}

impl Scan<'_> {
    /// `input.indexOf(pattern, from)`.
    fn index_of(&self, pattern: &str, from: isize) -> isize {
        let from = from.max(0) as usize;
        if from > self.input.len() {
            return -1;
        }
        self.input.as_bytes()[from..]
            .windows(pattern.len())
            .position(|w| w == pattern.as_bytes())
            .map_or(-1, |at| (from + at) as isize)
    }

    /// The text between two positions, as `substring` takes them.
    fn text(&self, from: isize, to: isize) -> &str {
        let len = self.input.len() as isize;
        let (a, b) = (from.clamp(0, len) as usize, to.clamp(0, len) as usize);
        let (a, b) = (a.min(b), a.max(b));
        self.input.get(a..b).unwrap_or_default()
    }

    /// Whether `pattern` is at `at`.
    fn is_at(&self, at: isize, pattern: &str) -> bool {
        at >= 0
            && self
                .input
                .as_bytes()
                .get(at as usize..at as usize + pattern.len())
                .is_some_and(|b| b == pattern.as_bytes())
    }

    fn unquoted(&self, from: isize, to: isize) -> String {
        self.text(from, to).replace("\"\"", "\"")
    }

    fn save_row(&mut self, cursor: isize) -> isize {
        self.cursor = cursor;
        self.rows.push(std::mem::take(&mut self.row));
        self.index_of(self.newline, self.cursor)
    }

    fn previewed(&self) -> bool {
        self.preview.is_some_and(|most| self.rows.len() >= most)
    }

    fn finish(mut self, value: Option<String>) -> Vec<Vec<String>> {
        let value =
            value.unwrap_or_else(|| self.text(self.cursor, self.input.len() as isize).to_owned());
        self.row.push(value);
        self.rows.push(std::mem::take(&mut self.row));
        self.rows
    }

    fn run(mut self) -> Vec<Vec<String>> {
        if self.input.is_empty() {
            return Vec::new();
        }
        let len = self.input.len() as isize;
        let (delimiter, newline) = (self.delimiter, self.newline);
        let mut next_delimiter = self.index_of(delimiter, self.cursor);
        let mut next_newline = self.index_of(newline, self.cursor);
        loop {
            if self.is_at(self.cursor, "\"") {
                let mut quote = self.cursor;
                self.cursor += 1;
                loop {
                    quote = self.index_of("\"", quote + 1);
                    if quote == -1 {
                        return self.finish(None);
                    }
                    if quote == len - 1 {
                        let value = self.unquoted(self.cursor, quote);
                        return self.finish(Some(value));
                    }
                    if self.is_at(quote + 1, "\"") {
                        quote += 1;
                        continue;
                    }
                    if next_delimiter != -1 && next_delimiter < quote + 1 {
                        next_delimiter = self.index_of(delimiter, quote + 1);
                    }
                    if next_newline != -1 && next_newline < quote + 1 {
                        next_newline = self.index_of(newline, quote + 1);
                    }
                    let check_up_to = if next_newline == -1 {
                        next_delimiter
                    } else {
                        next_delimiter.min(next_newline)
                    };
                    let spaces = self.spaces_after(quote, check_up_to);
                    if self.is_at(quote + 1 + spaces, delimiter) {
                        let value = self.unquoted(self.cursor, quote);
                        self.row.push(value);
                        self.cursor = quote + 1 + spaces + delimiter.len() as isize;
                        next_delimiter = self.index_of(delimiter, self.cursor);
                        next_newline = self.index_of(newline, self.cursor);
                        break;
                    }
                    let spaces = self.spaces_after(quote, next_newline);
                    if self.is_at(quote + 1 + spaces, newline) {
                        let value = self.unquoted(self.cursor, quote);
                        self.row.push(value);
                        next_newline = self.save_row(quote + 1 + spaces + newline.len() as isize);
                        next_delimiter = self.index_of(delimiter, self.cursor);
                        if self.previewed() {
                            return self.rows;
                        }
                        break;
                    }
                    quote += 1;
                }
                continue;
            }
            if next_delimiter != -1 && (next_delimiter < next_newline || next_newline == -1) {
                let field = self.text(self.cursor, next_delimiter).to_owned();
                self.row.push(field);
                self.cursor = next_delimiter + delimiter.len() as isize;
                next_delimiter = self.index_of(delimiter, self.cursor);
                continue;
            }
            if next_newline != -1 {
                let field = self.text(self.cursor, next_newline).to_owned();
                self.row.push(field);
                next_newline = self.save_row(next_newline + newline.len() as isize);
                if self.previewed() {
                    return self.rows;
                }
                continue;
            }
            break;
        }
        self.finish(None)
    }

    /// `extraSpaces`: how long the white space between the closing quote and `index` is, when
    /// only white space is there.
    fn spaces_after(&self, quote: isize, index: isize) -> isize {
        if index == -1 {
            return 0;
        }
        let between = self.text(quote + 1, index);
        if !between.is_empty() && js_number::trim(between).is_empty() {
            between.len() as isize
        } else {
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(text: &str) -> Value {
        Value::Array(parse(text).into_iter().map(Value::Object).collect())
    }

    /// Readings Papa Parse 5.7 gave in the Node app (`.port-logs/csv-import-node.ts`).
    #[test]
    fn exports_read_as_papa_parse_reads_them() {
        assert_eq!(
            read("a,b,a,b_1,b\n1,2,3,4,5,6\n7"),
            serde_json::json!([
                { "a": "1", "b": "2", "a_1": "3", "b_1": "4", "b_2": "5", "__parsed_extra": ["6"] },
                { "a": "7" },
            ])
        );
        assert_eq!(
            read("a,b\n\"1\"  ,\"x\" \n\n\"2\"x,y\n3,\"z"),
            serde_json::json!([{ "a": "1", "b": "x" }, { "a": "2\"x,y\n3,\"z" }])
        );
        assert_eq!(
            read("\u{feff}a\tb\n1\t\"q \"\"w\"\"\""),
            serde_json::json!([{ "a": "1", "b": "q \"w\"" }])
        );
        assert_eq!(
            read("a,b\r\n1,2\n3,4\r\n5,6\r\n"),
            serde_json::json!([
                { "a": "1", "b": "2\n3", "__parsed_extra": ["4"] },
                { "a": "5", "b": "6" },
            ])
        );
        assert_eq!(
            read("a\n1\n2"),
            serde_json::json!([{ "a": "1" }, { "a": "2" }])
        );
        assert_eq!(read(""), serde_json::json!([]));
    }

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
