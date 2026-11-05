//! A TCGplayer pull sheet CSV read into rows, as `pullSheetItems.ts` reads it: the trailing
//! "Orders Contained in Pull Sheet" line becomes the order numbers, and a product name with bare
//! quotes inside its quoted field (TCGplayer writes some that way) is repaired before reading.
use std::sync::LazyLock;

use regex::Regex;

/// A row of the sheet, with the columns the screen shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SheetRow {
    pub product_line: String,
    pub product_name: String,
    pub condition: String,
    pub number: String,
    pub set: String,
    pub rarity: String,
    pub quantity: String,
    pub set_release_date: String,
    pub sku_id: String,
    pub order_quantity: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Sheet {
    pub order_ids: Vec<String>,
    pub rows: Vec<SheetRow>,
}

const ORDERS_LINE: &str = "Orders Contained in Pull Sheet:";

/// The CSV without its trailing orders line, and the order numbers that line lists.
pub fn split_orders(text: &str) -> (&str, Vec<String>) {
    let trimmed = text.trim();
    let (body, last) = match trimmed.rfind('\n') {
        Some(at) => (&trimmed[..at], trimmed[at + 1..].trim()),
        None => ("", trimmed),
    };
    if !last.starts_with(ORDERS_LINE) {
        return (trimmed, Vec::new());
    }
    let after_label = last.split_once(',').map_or("", |(_, rest)| rest);
    let orders = after_label
        .split('|')
        .map(str::trim)
        .filter(|o| !o.is_empty())
        .map(String::from)
        .collect();
    (body.trim(), orders)
}

/// A data line whose product name (the second of eleven quoted fields) holds quotes that are not
/// doubled: `"Eustass"Captain"Kid"` for `Eustass"Captain"Kid`.
static MALFORMED_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^(?<prefix>"(?:[^"]|"")*",")(?<name>.*)(?<suffix>",(?:"(?:[^"]|"")*")(?:,"(?:[^"]|"")*"){8})$"#)
        .expect("the pattern compiles")
});

/// Whether `name` has a quote that is not one of a doubled pair.
fn has_bare_quote(name: &str) -> bool {
    let mut quotes = 0usize;
    for c in name.chars() {
        if c == '"' {
            quotes += 1;
        } else if quotes % 2 == 1 {
            return true;
        } else {
            quotes = 0;
        }
    }
    quotes % 2 == 1
}

/// The CSV with each malformed product name's quotes doubled, so a CSV reader reads it whole.
fn repair_product_names(csv: &str) -> String {
    let mut out = String::with_capacity(csv.len() + 16);
    for (i, line) in csv.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        let (line, cr) = line.strip_suffix('\r').map_or((line, ""), |l| (l, "\r"));
        match MALFORMED_NAME
            .captures(line)
            .filter(|c| i > 0 && has_bare_quote(&c["name"]))
        {
            Some(c) => {
                out.push_str(&c["prefix"]);
                out.push_str(&c["name"].replace('"', "\"\""));
                out.push_str(&c["suffix"]);
            }
            None => out.push_str(line),
        }
        out.push_str(cr);
    }
    out
}

/// Why a file is not a pull sheet, in the words the screen shows.
#[derive(Debug, PartialEq, Eq)]
pub enum SheetError {
    Empty,
    Unreadable(String),
    NoRows,
}

impl std::fmt::Display for SheetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SheetError::Empty => f.write_str("The pull sheet CSV was empty."),
            SheetError::Unreadable(reason) => write!(f, "CSV parsing errors: {reason}"),
            SheetError::NoRows => f.write_str(
                "No valid rows found in CSV. Expected columns: Product Line, Product Name, Condition, SkuId, etc.",
            ),
        }
    }
}

pub fn parse(text: &str) -> Result<Sheet, SheetError> {
    let (csv_text, order_ids) = split_orders(text);
    if csv_text.is_empty() {
        return Err(SheetError::Empty);
    }
    let repaired = repair_product_names(csv_text);
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(true)
        .from_reader(repaired.as_bytes());
    let headers = reader
        .headers()
        .map_err(|e| SheetError::Unreadable(e.to_string()))?
        .clone();
    let column = |name: &str| headers.iter().position(|h| h.trim() == name);
    let columns = [
        "Product Line",
        "Product Name",
        "Condition",
        "Number",
        "Set",
        "Rarity",
        "Quantity",
        "Set Release Date",
        "SkuId",
        "Order Quantity",
    ]
    .map(column);
    let mut rows = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|e| SheetError::Unreadable(e.to_string()))?;
        if record.iter().all(|f| f.trim().is_empty()) {
            continue;
        }
        let field = |i: usize| {
            columns[i]
                .and_then(|c| record.get(c))
                .unwrap_or("")
                .to_string()
        };
        let row = SheetRow {
            product_line: field(0),
            product_name: field(1),
            condition: field(2),
            number: field(3),
            set: field(4),
            rarity: field(5),
            quantity: field(6),
            set_release_date: field(7),
            sku_id: field(8),
            order_quantity: field(9),
        };
        if !row.sku_id.is_empty() && !row.product_name.is_empty() {
            rows.push(row);
        }
    }
    if rows.is_empty() {
        return Err(SheetError::NoRows);
    }
    Ok(Sheet { order_ids, rows })
}

/// The year a set came out, as the sheet writes its date (`01/16/2026 00:00:00` or
/// `2024-01-01`). The React app read it through `Date` in the browser's zone, which put an ISO
/// date's January 1 in the year before west of UTC; this reads the year as written.
pub fn release_year(date: &str) -> Option<String> {
    let date = date.split_whitespace().next()?;
    let year = if let Some((year, _)) = date.split_once('-') {
        year
    } else {
        date.rsplit('/').next()?
    };
    (year.len() == 4 && year.bytes().all(|b| b.is_ascii_digit())).then(|| year.to_string())
}

/// TCGplayer's sheet names Magic as "Magic"; the catalog as "Magic: The Gathering".
pub fn catalog_product_line(name: &str) -> String {
    let name = name.trim();
    if name.eq_ignore_ascii_case("magic") {
        "Magic: The Gathering".to_string()
    } else {
        name.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "Product Line,Product Name,Condition,Number,Set,Rarity,Quantity,Main Photo URL,Set Release Date,SkuId,Order Quantity\n\
        Pokemon,Charizard ex,Near Mint,H4,Base,Ultra Rare,2,https://example.com,2024-01-01,101,ORD-1\n\
        Pokemon,Pikachu,Lightly Played,25,Jungle,Common,1,https://example.com,1999-01-09,202,ORD-2";

    #[test]
    fn the_trailing_orders_line_becomes_order_numbers() {
        let text = format!("{SAMPLE}\nOrders Contained in Pull Sheet:, ORD-1 | ORD-2 ");
        let (csv, orders) = split_orders(&text);
        assert_eq!(orders, ["ORD-1", "ORD-2"]);
        assert!(csv.contains("Charizard ex") && !csv.contains(ORDERS_LINE));
    }

    #[test]
    fn rows_and_order_numbers_are_read() {
        let sheet = parse(&format!(
            "{SAMPLE}\nOrders Contained in Pull Sheet:,ORD-1|ORD-2"
        ))
        .unwrap();
        assert_eq!(sheet.rows.len(), 2);
        assert_eq!(sheet.order_ids, ["ORD-1", "ORD-2"]);
        assert_eq!(sheet.rows[0].sku_id, "101");
    }

    #[test]
    fn a_file_with_no_usable_rows_is_refused() {
        let refused = parse("Product Line,Product Name,Condition,SkuId\nPokemon,,,").unwrap_err();
        assert!(
            refused
                .to_string()
                .starts_with("No valid rows found in CSV")
        );
        assert_eq!(parse("  ").unwrap_err(), SheetError::Empty);
    }

    #[test]
    fn bare_quotes_in_a_product_name_are_repaired() {
        let csv = "Product Line,Product Name,Condition,Number,Set,Rarity,Quantity,Main Photo URL,Set Release Date,SkuId,Order Quantity\n\
            \"One Piece Card Game\",\"Eustass\"Captain\"Kid - EB04-039 (SP)\",\"Near Mint Foil\",\"EB04-039\",\"The Azure Sea's Seven\",\"R\",\"1\",\"\",\"01/16/2026 00:00:00\",\"9077713\",\"ORDER-1\"";
        let sheet = parse(csv).unwrap();
        assert_eq!(sheet.rows.len(), 1);
        assert_eq!(
            sheet.rows[0].product_name,
            "Eustass\"Captain\"Kid - EB04-039 (SP)"
        );
        assert_eq!(sheet.rows[0].sku_id, "9077713");
    }

    #[test]
    fn a_well_formed_doubled_quote_is_left_alone() {
        let csv = "Product Line,Product Name,Condition,Number,Set,Rarity,Quantity,Main Photo URL,Set Release Date,SkuId,Order Quantity\n\
            \"Magic\",\"\"\"Ach! Hans, Run!\"\"\",\"Near Mint\",\"1\",\"Unhinged\",\"R\",\"1\",\"\",\"11/19/2004 00:00:00\",\"5\",\"ORDER-1\"";
        assert_eq!(
            parse(csv).unwrap().rows[0].product_name,
            "\"Ach! Hans, Run!\""
        );
    }

    #[test]
    fn the_release_year_is_read_as_written() {
        assert_eq!(release_year("01/16/2026 00:00:00").as_deref(), Some("2026"));
        assert_eq!(release_year("2024-01-01").as_deref(), Some("2024"));
        assert_eq!(release_year(""), None);
        assert_eq!(release_year("soon"), None);
    }

    #[test]
    fn magic_is_named_as_the_catalog_names_it() {
        assert_eq!(catalog_product_line(" magic "), "Magic: The Gathering");
        assert_eq!(catalog_product_line("Pokemon"), "Pokemon");
    }
}
