//! A complete observation of the seller's inventory, ported from `inventoryObservation.ts`: the
//! Seller Portal pricing page must name the seller in at least two declarations, and its
//! **Export From Live** CSV is read to one item per inventory identity (a standard SKU, or a
//! custom listing kept as evidence), sorted by its key, with fingerprints of its quantities.
//! Refusals are the message Node's `Error` carries.
use std::{collections::HashSet, sync::LazyLock};

use regex::Regex;
use serde_json::json;

use crate::{
    csv_text::{self, Reading},
    features::inventory_economics::ledger::fingerprint::sha256_hex,
    js_number,
};

const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_ROWS: usize = 50_000;
const MAX_DATABASE_INTEGER: i64 = 2_147_483_647;
const REQUIRED: [&str; 6] = [
    "TCGplayer Id",
    "Total Quantity",
    "Product Line",
    "Set Name",
    "Product Name",
    "Condition",
];

/// One inventory identity the export listed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub inventory_key: String,
    /// The standard SKU, or none for a custom listing (`identityKind: "unsupported"`).
    pub sku: Option<i32>,
    pub quantity: i32,
    pub product_line: String,
    pub set_name: String,
    pub product_name: String,
    pub condition: String,
    pub variant: String,
}

impl Item {
    pub fn identity_kind(&self) -> &'static str {
        if self.sku.is_some() {
            "standard_sku"
        } else {
            "unsupported"
        }
    }
}

static SELLER_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(["']?sellerKey["']?)\s*[:=]\s*["']([^"']+)["']"#).expect("valid")
});

/// `validateSellerPricingContext`: how many declarations of the seller the page made, when there
/// are at least two and every one names `expected`.
pub fn validate_context(html: &str, expected: &str) -> Result<usize, String> {
    let keys: Vec<&str> = SELLER_KEY
        .captures_iter(html)
        .map(|c| js_number::trim(c.get(2).map_or("", |m| m.as_str())))
        .filter(|key| !key.is_empty())
        .collect();
    if keys.len() < 2 {
        return Err(
            "Seller Portal context did not contain the verified seller identity declarations."
                .into(),
        );
    }
    let expected = js_number::trim(expected);
    if keys.iter().any(|key| *key != expected) {
        return Err("Seller Portal context does not match the expected seller key.".into());
    }
    Ok(keys.len())
}

fn digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// `parseCompleteInventoryExport`: the export's items in inventory key order, or why it cannot
/// be trusted as a complete observation.
pub fn parse_export(csv: &str) -> Result<Vec<Item>, String> {
    if csv.len() > MAX_BYTES {
        return Err("Inventory export exceeds 8 MB.".into());
    }
    let table = csv_text::read(
        csv,
        Reading {
            greedy: true,
            trim_header: false,
        },
    );
    if let Some(error) = table.error {
        return Err(format!("Inventory export is malformed: {error}"));
    }
    if table.rows.len() > MAX_ROWS {
        return Err("Inventory export exceeds 50,000 rows.".into());
    }
    for column in REQUIRED {
        if !table.fields.iter().any(|f| f == column) {
            return Err(format!("Inventory export is missing {column}."));
        }
    }
    let mut seen = HashSet::new();
    let mut seen_skus = HashSet::new();
    let mut items = Vec::with_capacity(table.rows.len());
    for (index, row) in table.rows.iter().enumerate() {
        let field = |name: &str| row.get(name).and_then(|v| v.as_str()).map(js_number::trim);
        let inventory_key = field("TCGplayer Id").unwrap_or("");
        let sku = digits(inventory_key).then(|| js_number::number(inventory_key));
        let quantity_text = field("Total Quantity").unwrap_or("");
        let quantity = js_number::number(quantity_text);
        let printable = (1..=100).contains(&inventory_key.len())
            && inventory_key.bytes().all(|b| (0x21..=0x7e).contains(&b));
        let sku_valid =
            sku.is_none_or(|s| s.fract() == 0.0 && s > 0.0 && s <= MAX_DATABASE_INTEGER as f64);
        if !printable
            || !sku_valid
            || !digits(quantity_text)
            || quantity > MAX_DATABASE_INTEGER as f64
        {
            return Err(format!(
                "Inventory export row {} has an invalid SKU or quantity.",
                index + 2
            ));
        }
        let sku = sku.map(|s| s as i32);
        if seen.contains(inventory_key) || sku.is_some_and(|s| seen_skus.contains(&s)) {
            return Err(format!(
                "Inventory export repeats identity {inventory_key}."
            ));
        }
        seen.insert(inventory_key.to_owned());
        if let Some(sku) = sku {
            seen_skus.insert(sku);
        }
        let text = |name: &str| field(name).unwrap_or("").to_owned();
        items.push(Item {
            inventory_key: inventory_key.to_owned(),
            sku,
            quantity: quantity as i32,
            product_line: text("Product Line"),
            set_name: text("Set Name"),
            product_name: text("Product Name"),
            condition: text("Condition"),
            variant: field("Printing")
                .or_else(|| field("Sku Variant"))
                .unwrap_or("")
                .to_owned(),
        });
    }
    // Every key is printable ASCII, so byte order is JavaScript's `<`.
    items.sort_by(|a, b| a.inventory_key.cmp(&b.inventory_key));
    let total: i64 = items.iter().map(|i| i64::from(i.quantity)).sum();
    if total > MAX_DATABASE_INTEGER {
        return Err("Inventory export total quantity exceeds the supported range.".into());
    }
    Ok(items)
}

/// `quantityFingerprint`: every identity's quantity, in key order.
pub fn quantity_fingerprint(items: &[Item]) -> String {
    let mut keyed: Vec<(&str, i32)> = items
        .iter()
        .map(|i| (i.inventory_key.as_str(), i.quantity))
        .collect();
    keyed.sort_by(|a, b| a.0.cmp(b.0));
    sha256_hex(&json!(keyed).to_string())
}

/// `supportedQuantityFingerprint`: every standard SKU's quantity, in SKU order.
pub fn supported_quantity_fingerprint(items: &[Item]) -> String {
    let mut supported: Vec<(i32, i32)> = items
        .iter()
        .filter_map(|i| i.sku.map(|sku| (sku, i.quantity)))
        .collect();
    supported.sort_by_key(|(sku, _)| *sku);
    sha256_hex(&json!(supported).to_string())
}

/// `contentFingerprint`: the export as it was sent.
pub fn content_fingerprint(content: &str) -> String {
    sha256_hex(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn csv(quantity: &str, price: &str) -> String {
        format!(
            "TCGplayer Id,Product Line,Set Name,Product Name,Condition,Total Quantity,TCG Marketplace Price\n100,Game,Set,Card,Near Mint,{quantity},{price}"
        )
    }

    /// `inventoryObservation.test.ts`'s cases.
    #[test]
    fn observations_validate_seller_rows_and_quantities_as_node_does() {
        assert_eq!(
            validate_context(
                "{'sellerKey': 'seller-a'} sellerKey: 'seller-a'",
                "seller-a"
            ),
            Ok(2)
        );
        assert!(
            validate_context(
                "{'sellerKey': 'seller-b'} sellerKey: 'seller-b'",
                "seller-a"
            )
            .unwrap_err()
            .contains("does not match")
        );
        assert!(
            validate_context("sellerKey: 'seller-a'", "seller-a")
                .unwrap_err()
                .contains("declarations")
        );
        let one = parse_export(&csv("2", "1.00")).unwrap();
        assert_eq!(one[0].quantity, 2);
        assert_eq!(
            quantity_fingerprint(&one),
            quantity_fingerprint(&parse_export(&csv("2", "9.99")).unwrap())
        );
        let repeated = format!("{}\n0100,Game,Set,Card,Near Mint,2,1.00", csv("2", "1.00"));
        assert!(
            parse_export(&repeated)
                .unwrap_err()
                .contains("repeats identity")
        );
        assert!(
            parse_export(&csv("2147483648", "1.00"))
                .unwrap_err()
                .contains("invalid SKU or quantity")
        );
        let custom = format!(
            "{}\nC-3967723,Game,Set,Custom,Near Mint,1,4.00",
            csv("2", "1.00")
        );
        let with_custom = parse_export(&custom).unwrap();
        let identities: Vec<(&str, Option<i32>, &str)> = with_custom
            .iter()
            .map(|i| (i.inventory_key.as_str(), i.sku, i.identity_kind()))
            .collect();
        assert_eq!(
            identities,
            [
                ("100", Some(100), "standard_sku"),
                ("C-3967723", None, "unsupported")
            ]
        );
        assert_eq!(
            supported_quantity_fingerprint(&with_custom),
            supported_quantity_fingerprint(&one)
        );
    }

    /// Node: `JSON.stringify([["100",2]])` and `JSON.stringify([[100,2]])` hashed.
    #[test]
    fn fingerprints_hash_what_node_stringifies() {
        let one = parse_export(&csv("2", "1.00")).unwrap();
        assert_eq!(quantity_fingerprint(&one), sha256_hex(r#"[["100",2]]"#));
        assert_eq!(
            supported_quantity_fingerprint(&one),
            sha256_hex("[[100,2]]")
        );
    }

    #[test]
    fn a_missing_column_or_a_bad_row_is_named() {
        assert_eq!(
            parse_export("TCGplayer Id,Total Quantity\n1,2").unwrap_err(),
            "Inventory export is missing Product Line."
        );
        let negative = csv("-1", "1.00");
        assert_eq!(
            parse_export(&negative).unwrap_err(),
            "Inventory export row 2 has an invalid SKU or quantity."
        );
        let printing = "TCGplayer Id,Product Line,Set Name,Product Name,Condition,Total Quantity,Printing,Sku Variant\n7,G,S,P,NM,0,,Foil";
        assert_eq!(parse_export(printing).unwrap()[0].variant, "");
    }
}
