//! A sheet's rows as the screen shows them: each with what the catalog knows of its SKU (its
//! product, for the picture, and its printing), and the condition and printing as the looks
//! the screen gives them.
use std::collections::HashMap;

use super::sheet::{SheetRow, catalog_product_line, release_year};
use crate::database::Database;

/// What the catalog knows of a SKU on the sheet.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct CatalogSku {
    pub sku: i32,
    pub product_id: i32,
    pub variant: String,
    pub condition: String,
    pub product_line_name: String,
}

#[derive(Clone, Debug)]
pub struct Item {
    pub product_line: String,
    pub product_name: String,
    pub condition: String,
    pub number: String,
    pub set: String,
    pub release_year: Option<String>,
    pub rarity: String,
    pub quantity: u32,
    pub order_quantity: String,
    pub catalog: Option<CatalogSku>,
}

impl Item {
    /// The condition the catalog gives the SKU, else the sheet's.
    pub fn shown_condition(&self) -> &str {
        self.catalog
            .as_ref()
            .map_or(&self.condition, |c| &c.condition)
    }

    pub fn variant(&self) -> &str {
        self.catalog.as_ref().map_or("", |c| &c.variant)
    }

    /// The product name with the card number after it, unless the name already has it.
    pub fn display_name(&self) -> String {
        if self.number.is_empty()
            || self
                .product_name
                .to_lowercase()
                .contains(&self.number.to_lowercase())
        {
            self.product_name.clone()
        } else {
            format!("{} - {}", self.product_name, self.number)
        }
    }

    /// What the filter matches: the name, set, number and product line.
    pub fn search_text(&self) -> String {
        format!(
            "{} {} {} {}",
            self.product_name, self.set, self.number, self.product_line
        )
        .to_lowercase()
    }
}

/// The SKUs on the sheet that the catalog has, each under a product line the sheet names (the
/// React app looked them up per product line by name; a SKU under another line is not found).
pub async fn find_skus(db: &Database, rows: &[SheetRow]) -> sqlx::Result<HashMap<i32, CatalogSku>> {
    let ids: Vec<i32> = rows
        .iter()
        .filter_map(|r| r.sku_id.trim().parse().ok())
        .collect();
    let found: Vec<CatalogSku> = sqlx::query_as(
        "SELECT s.sku, s.product_id, s.variant, s.condition, pl.product_line_name
         FROM skus s JOIN product_lines pl ON pl.product_line_id = s.product_line_id
         WHERE s.sku = ANY($1)",
    )
    .bind(&ids)
    .fetch_all(&db.0)
    .await?;
    Ok(found.into_iter().map(|sku| (sku.sku, sku)).collect())
}

pub fn items(rows: Vec<SheetRow>, skus: &HashMap<i32, CatalogSku>) -> Vec<Item> {
    rows.into_iter()
        .map(|row| {
            let product_line = catalog_product_line(&row.product_line);
            let catalog = row
                .sku_id
                .trim()
                .parse::<i32>()
                .ok()
                .and_then(|id| skus.get(&id))
                .filter(|sku| sku.product_line_name.eq_ignore_ascii_case(&product_line))
                .cloned();
            Item {
                release_year: release_year(&row.set_release_date),
                quantity: row
                    .quantity
                    .trim()
                    .parse()
                    .ok()
                    .filter(|q| *q > 0)
                    .unwrap_or(1),
                product_line,
                product_name: row.product_name,
                condition: row.condition,
                number: row.number,
                set: row.set,
                rarity: row.rarity,
                order_quantity: row.order_quantity,
                catalog,
            }
        })
        .collect()
}

/// How a condition looks: a color per grade, as the React app's chips and borders.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Grade {
    NearMint,
    LightlyPlayed,
    ModeratelyPlayed,
    HeavilyPlayed,
    Damaged,
}

impl Grade {
    pub fn of(condition: &str) -> Grade {
        let c = condition.to_lowercase();
        if c.contains("lightly played") {
            Grade::LightlyPlayed
        } else if c.contains("moderately played") {
            Grade::ModeratelyPlayed
        } else if c.contains("heavily played") {
            Grade::HeavilyPlayed
        } else if c.contains("damaged") {
            Grade::Damaged
        } else {
            Grade::NearMint
        }
    }
}

/// How a printing looks: the shimmer a holo or reverse holo gets, and a first edition's badge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Printing {
    pub finish: Finish,
    pub first_edition: bool,
    pub label: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Finish {
    Plain,
    Holo,
    ReverseHolo,
}

impl Printing {
    /// `getVariantVisuals` in the React app: the finish, the edition and the short label.
    pub fn of(variant: &str) -> Printing {
        let v = variant.trim().to_lowercase();
        let foil = v.contains("holo") || v.contains("foil");
        let finish = if v.contains("reverse") && foil {
            Finish::ReverseHolo
        } else if foil {
            Finish::Holo
        } else {
            Finish::Plain
        };
        let first_edition = v.contains("1st edition") || v.contains("first edition");
        let mut parts = Vec::new();
        if first_edition {
            parts.push("1st Ed");
        } else if v.contains("unlimited") {
            parts.push("Unlimited");
        }
        match finish {
            Finish::ReverseHolo => parts.push("Reverse Holo"),
            Finish::Holo => parts.push("Holo"),
            Finish::Plain => {}
        }
        let label = if !parts.is_empty() {
            Some(parts.join(" "))
        } else if !v.is_empty() && v != "normal" {
            Some(variant.trim().to_string())
        } else {
            None
        };
        Printing {
            finish,
            first_edition,
            label,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn printings_get_the_react_apps_labels() {
        assert_eq!(
            Printing::of("Reverse Holofoil").label.as_deref(),
            Some("Reverse Holo")
        );
        assert_eq!(Printing::of("Reverse Holofoil").finish, Finish::ReverseHolo);
        let first = Printing::of("1st Edition Holofoil");
        assert_eq!(
            (first.finish, first.first_edition, first.label.as_deref()),
            (Finish::Holo, true, Some("1st Ed Holo"))
        );
        assert_eq!(
            Printing::of("Unlimited").label.as_deref(),
            Some("Unlimited")
        );
        assert_eq!(Printing::of("Normal").label, None);
        assert_eq!(Printing::of("Foil Etched").label.as_deref(), Some("Holo"));
        assert_eq!(
            Printing::of("Gold Border").label.as_deref(),
            Some("Gold Border")
        );
    }

    #[test]
    fn found_skus_must_be_under_the_sheets_product_line() {
        let row = |sku: &str, line: &str| SheetRow {
            product_line: line.into(),
            product_name: "Charizard ex".into(),
            condition: "Near Mint".into(),
            number: "H4".into(),
            set: "Base".into(),
            rarity: "Ultra Rare".into(),
            quantity: "2".into(),
            set_release_date: "2024-01-01".into(),
            sku_id: sku.into(),
            order_quantity: "ORD-1".into(),
        };
        let skus = HashMap::from([(
            101,
            CatalogSku {
                sku: 101,
                product_id: 999,
                variant: "Holofoil".into(),
                condition: "Near Mint".into(),
                product_line_name: "Pokemon".into(),
            },
        )]);
        let found = items(
            vec![
                row("101", "Pokemon"),
                row("202", "Pokemon"),
                row("101", "Magic"),
            ],
            &skus,
        );
        assert_eq!(found[0].catalog.as_ref().map(|c| c.product_id), Some(999));
        assert_eq!(found[0].quantity, 2);
        assert!(found[1].catalog.is_none() && found[2].catalog.is_none());
        assert_eq!(found[0].display_name(), "Charizard ex - H4");
    }
}
