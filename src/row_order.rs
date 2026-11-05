//! The rows a table shows, in the order its sort header asks for, by the rules
//! `corten_ui::rows::sort` orders them in the browser: a page drawn without the script is in the
//! order a click with it gives. A column's cells are numbers or text, never both; text is in
//! numeric collation (`PSA 9` before `PSA 10`), an empty value is last either way, and equal rows
//! keep their order.
use std::cmp::Ordering;

use crate::{features::inventory_strategy::collate, ui::table::Sort};

/// What one cell sorts by.
pub enum Key {
    Number(f64),
    Text(String),
}

impl Key {
    fn cmp(&self, other: &Key) -> Ordering {
        match (self, other) {
            (Key::Number(a), Key::Number(b)) => a.partial_cmp(b).unwrap_or(Ordering::Equal),
            (Key::Text(a), Key::Text(b)) => collate::compare_numeric(a.trim(), b.trim()),
            (Key::Number(_), Key::Text(_)) => Ordering::Less,
            (Key::Text(_), Key::Number(_)) => Ordering::Greater,
        }
    }
}

/// `rows` by `key`, descending when `down`; a row whose key is none is last.
pub fn sort<T>(rows: &mut [T], down: bool, key: impl Fn(&T) -> Option<Key>) {
    rows.sort_by(|a, b| match (key(a), key(b)) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) if down => x.cmp(&y).reverse(),
        (Some(x), Some(y)) => x.cmp(&y),
    });
}

/// `column`'s `aria-sort` when the rows are sorted by `by` (`down` when descending).
pub fn header<C: PartialEq>(by: Option<&C>, down: bool, column: &C) -> Option<Sort> {
    match by {
        Some(by) if by == column && down => Some(Sort::Descending),
        Some(by) if by == column => Some(Sort::Ascending),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_as_the_script_does() {
        let mut rows = vec![(1, Some(9.0)), (2, None), (3, Some(12.0)), (4, Some(9.0))];
        let key = |r: &(i32, Option<f64>)| r.1.map(Key::Number);
        sort(&mut rows, false, key);
        assert_eq!(rows.iter().map(|r| r.0).collect::<Vec<_>>(), [1, 4, 3, 2]);
        sort(&mut rows, true, key);
        // Equal rows keep their order and the empty one stays last.
        assert_eq!(rows.iter().map(|r| r.0).collect::<Vec<_>>(), [3, 1, 4, 2]);

        let mut grades = vec!["PSA 10", "PSA 9", "BGS 9.5"];
        sort(&mut grades, false, |g| Some(Key::Text(g.to_string())));
        assert_eq!(grades, ["BGS 9.5", "PSA 9", "PSA 10"]);
    }

    #[test]
    fn a_header_is_sorted_only_by_its_own_column() {
        assert_eq!(
            header(Some(&"price"), false, &"price"),
            Some(Sort::Ascending)
        );
        assert_eq!(
            header(Some(&"price"), true, &"price"),
            Some(Sort::Descending)
        );
        assert_eq!(header(Some(&"date"), true, &"price"), None);
        assert_eq!(header(None, false, &"price"), None);
    }
}
