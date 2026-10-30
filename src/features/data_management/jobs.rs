//! The jobs, what each form sends for one, and the product lines they choose from.
use corten::prelude::*;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::database::Database;

/// One of the five jobs, as its form names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Job {
    ProductLines,
    NewProducts,
    EveryProduct,
    Product,
    Set,
}

/// What a job came to: what it did, or why it did not, in the Node app's words.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ran {
    Done(String),
    Failed(String),
}

/// A product line to choose: its id, its name, and the name TCGplayer's addresses use for it,
/// which a set is looked up by.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Line {
    pub id: i32,
    pub name: String,
    pub url_name: String,
}

pub async fn lines(db: &Database) -> sqlx::Result<Vec<Line>> {
    sqlx::query_as(
        "SELECT product_line_id AS id, product_line_name AS name, product_line_url_name AS url_name
        FROM product_lines ORDER BY product_line_name",
    )
    .fetch_all(&db.0)
    .await
}

/// A product line for a job that reads one: its new products, or every product.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
pub struct LineInput {
    pub product_line: Option<i32>,
}

impl LineInput {
    pub fn first(lines: &[Line]) -> Self {
        LineInput {
            product_line: lines.first().map(|l| l.id),
        }
    }

    pub fn read(&self, lines: &[Line]) -> Result<i32, Errors> {
        let mut errors = Errors::new();
        let id = known(
            &mut errors,
            Self::FIELDS.product_line,
            self.product_line,
            lines,
        );
        errors.into_result(id)
    }
}

/// One product to read again, by its TCGplayer id, in the product line it is stored under.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
pub struct ProductInput {
    pub product_line: Option<i32>,
    pub product: Option<i32>,
}

impl ProductInput {
    pub fn first(lines: &[Line]) -> Self {
        ProductInput {
            product_line: lines.first().map(|l| l.id),
            product: None,
        }
    }

    pub fn read(&self, lines: &[Line]) -> Result<(i32, i32), Errors> {
        let f = Self::FIELDS;
        let mut errors = Errors::new();
        let line = known(&mut errors, f.product_line, self.product_line, lines);
        let product = match self.product {
            Some(id) if id > 0 => id,
            _ => {
                errors.add(f.product, "Enter the exact TCGplayer product ID.");
                0
            }
        };
        errors.into_result((line, product))
    }
}

/// One set to read from TCGplayer by its name, in a product line chosen by its address name,
/// optionally deleting what is stored for it first.
#[derive(Clone, Debug, Default, Deserialize, Fields)]
pub struct SetInput {
    #[serde(default)]
    pub set_name: String,
    #[serde(default)]
    pub product_line: String,
    #[serde(default)]
    pub delete_existing: bool,
}

impl SetInput {
    pub fn first(lines: &[Line]) -> Self {
        SetInput {
            product_line: lines
                .first()
                .map(|l| l.url_name.clone())
                .unwrap_or_default(),
            ..SetInput::default()
        }
    }

    pub fn read(&self, lines: &[Line]) -> Result<(String, String), Errors> {
        let f = Self::FIELDS;
        let mut errors = Errors::new();
        let set = self.set_name.trim();
        if set.is_empty() {
            errors.add(f.set_name, "Enter the set's name as TCGplayer writes it.");
        }
        if !lines.iter().any(|l| l.url_name == self.product_line) {
            errors.add(f.product_line, "Choose the product line the set is in.");
        }
        errors.into_result((set.to_owned(), self.product_line.clone()))
    }
}

fn known(errors: &mut Errors, field: FieldName, id: Option<i32>, lines: &[Line]) -> i32 {
    match id.filter(|id| lines.iter().any(|l| l.id == *id)) {
        Some(id) => id,
        None => {
            errors.add(field, "Choose a product line.");
            0
        }
    }
}

/// What the Node app's `/api/data-management` is sent for a job: the React form's fields.
pub fn ask(job: Job, fields: Value) -> Value {
    let action_type = match job {
        Job::ProductLines => "fetchAllProductLines",
        Job::NewProducts => "syncNewProducts",
        Job::EveryProduct => "fetchAllCategory3Data",
        Job::Product => "updateProductAndSkus",
        Job::Set => "fetchSetProductsAndSkus",
    };
    let mut body = json!({ "actionType": action_type });
    if let (Value::Object(body), Value::Object(fields)) = (&mut body, fields) {
        body.extend(fields);
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines() -> Vec<Line> {
        vec![Line {
            id: 3,
            name: "Pokemon".into(),
            url_name: "pokemon".into(),
        }]
    }

    #[test]
    fn a_form_reads_a_known_product_line_and_names_what_is_missing() {
        assert_eq!(LineInput::first(&lines()).read(&lines()).unwrap(), 3);
        let unknown = LineInput {
            product_line: Some(99),
        };
        assert!(
            unknown
                .read(&lines())
                .unwrap_err()
                .has(LineInput::FIELDS.product_line)
        );
        let blank = ProductInput::first(&lines()).read(&lines()).unwrap_err();
        assert_eq!(
            blank.get(ProductInput::FIELDS.product),
            Some("Enter the exact TCGplayer product ID.")
        );
        let set = SetInput {
            set_name: "  ".into(),
            ..SetInput::first(&lines())
        };
        let errors = set.read(&lines()).unwrap_err();
        assert!(errors.has(SetInput::FIELDS.set_name));
        assert_eq!(errors.len(), 1);
    }

    #[test]
    fn a_job_is_asked_for_with_the_react_forms_fields() {
        assert_eq!(
            ask(
                Job::Product,
                json!({ "productId": "42", "productLineId": "3" })
            ),
            json!({ "actionType": "updateProductAndSkus", "productId": "42", "productLineId": "3" })
        );
        assert_eq!(
            ask(Job::ProductLines, Value::Null),
            json!({ "actionType": "fetchAllProductLines" })
        );
    }
}
