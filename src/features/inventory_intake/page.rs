use std::collections::HashMap;

use corten::{Mode, UrlValue, axum::http::StatusCode, prelude::*};
use serde::Deserialize;

use super::{
    catalog::{self, Condition, Product, ProductLine, Scope, Set, Shown},
    pending::{self, Change, Place, Totals},
    url::{self, Selection},
    views::{Counted, IntakeError, IntakeScreen, QuantityField, QueueTotals},
};
use crate::{
    database::Database,
    layout::{Chrome, Layout},
    legacy::Legacy,
};

/// Everything the screen draws for a selection.
pub struct Screen {
    pub selection: Selection,
    pub lines: Vec<ProductLine>,
    pub line: i32,
    pub sets: Vec<Set>,
    pub set: Option<i32>,
    pub scope: Scope,
    pub condition: Condition,
    pub products: Vec<Product>,
    pub quantities: HashMap<i32, i32>,
    pub totals: Totals,
}

impl Screen {
    pub async fn read(db: &Database, selection: &Selection) -> sqlx::Result<Screen> {
        let line = selection.line.unwrap_or(catalog::DEFAULT_PRODUCT_LINE);
        let (lines, sets, quantities) = tokio::try_join!(
            catalog::product_lines(db),
            catalog::sets(db, line),
            pending::quantities(db)
        )?;
        let set = selection
            .set
            .filter(|id| sets.iter().any(|s| s.id == *id))
            .or_else(|| sets.first().map(|s| s.id));
        let scope = selection.scope.unwrap_or_default();
        let search = selection.search.as_deref().unwrap_or("").trim();
        let skus = match (scope, set) {
            (Scope::AllSets, _) => catalog::card_number_skus(db, line, search).await?,
            (Scope::Set, Some(set)) => catalog::set_skus(db, line, set).await?,
            (Scope::Set, None) => Vec::new(),
        };
        let shown = Shown {
            product_type: selection.product_type.unwrap_or_default(),
            languages: &selection.language,
        };
        let products = catalog::products(skus, &shown);
        let products = match scope {
            Scope::Set => catalog::search(products, search),
            Scope::AllSets => products,
        };
        Ok(Screen {
            selection: selection.clone(),
            lines,
            line,
            sets,
            set,
            scope,
            condition: selection.condition.unwrap_or_default(),
            products,
            totals: Totals::of(&quantities),
            quantities,
        })
    }
}

pub async fn show(
    req: Req,
    State(db): State<Database>,
    Params(at): Params<url::InventoryManager>,
) -> HtmlResult {
    let screen = Screen::read(&db, &at.selection).await?;
    let chrome = Chrome::read(&db).await;
    req.page(html! {
        <Layout req={&req} title="Inventory Manager" chrome={chrome}>
            <IntakeScreen screen={&screen} error={None} />
        </Layout>
    })
}

/// How a count changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, UrlValue, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeKind {
    Add,
    Remove,
    Set,
}

/// One SKU's count changed by the screen's script: the SKU and where it belongs, the field's
/// label (to draw it again), the change, and the request id the change is applied once by.
#[derive(Clone, Debug, Deserialize, Fields)]
pub struct CountInput {
    pub sku: i32,
    pub product: i32,
    pub set: i32,
    pub line: i32,
    pub label: String,
    pub change: ChangeKind,
    pub quantity: u32,
    /// For a set, the count the user saw.
    #[serde(default)]
    pub seen: Option<u32>,
    pub request: String,
}

impl CountInput {
    fn change(&self) -> Change {
        match self.change {
            ChangeKind::Add => Change::Add(self.quantity),
            ChangeKind::Remove => Change::Remove(self.quantity),
            ChangeKind::Set => Change::Set {
                quantity: self.quantity,
                seen: self.seen.unwrap_or(0),
            },
        }
    }

    fn place(&self) -> Place {
        Place {
            product_line_id: self.line,
            set_id: self.set,
            product_id: self.product,
        }
    }
}

/// The SKU's field with the count stored, the totals, and what went wrong, if anything.
pub async fn count(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    Params(at): Params<url::Count>,
    Form(input): Form<CountInput>,
) -> HtmlResult {
    let applied = pending::change(
        &legacy,
        &input.request,
        input.sku,
        input.place(),
        input.change(),
    )
    .await;
    if req.mode != Mode::Action {
        return req.redirect(&url::InventoryManager {
            selection: at.selection,
        });
    }
    let quantities = pending::quantities(&db).await?;
    let stored = quantities.get(&input.sku).copied().unwrap_or(0);
    let totals = Totals::of(&quantities);
    let counted = Counted::from(&input);
    let field = html! {
        <QuantityField counted={&counted} quantity={stored} />
        <QueueTotals totals={totals} />
    };
    match applied {
        Ok(_) => req.patch(html! {
            {field}
            <IntakeError message={None} />
        }),
        Err(message) => req.patch_with_status(
            StatusCode::CONFLICT,
            html! {
                {field}
                <IntakeError message={Some(&message)} />
            },
        ),
    }
}

/// The table's counts without JavaScript: each field is named by its SKU, and those that differ
/// from what is stored are set, each once by the form's submit key.
pub async fn save_counts(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    Params(at): Params<url::SaveCounts>,
    Form(fields): Form<HashMap<String, String>>,
) -> HtmlResult {
    let screen = Screen::read(&db, &at.selection).await?;
    let submit = fields.get("submit").cloned().unwrap_or_default();
    let mut failed = None;
    for product in &screen.products {
        for sku in Condition::ALL
            .iter()
            .filter_map(|c| product.sku(*c))
            .chain(product.unopened)
        {
            let Some(typed) = fields.get(&sku.to_string()) else {
                continue;
            };
            let Ok(quantity) = typed.trim().parse::<u32>() else {
                continue;
            };
            let seen = screen.quantities.get(&sku).copied().unwrap_or(0).max(0) as u32;
            if quantity == seen {
                continue;
            }
            let place = Place {
                product_line_id: product.product_line_id,
                set_id: product.set_id,
                product_id: product.product_id,
            };
            let request = format!("{submit}-{sku}");
            if let Err(message) = pending::change(
                &legacy,
                &request,
                sku,
                place,
                Change::Set { quantity, seen },
            )
            .await
            {
                failed = Some(message);
            }
        }
    }
    match failed {
        None => req.redirect(&url::InventoryManager {
            selection: at.selection,
        }),
        Some(message) => {
            let screen = Screen::read(&db, &at.selection).await?;
            let chrome = Chrome::read(&db).await;
            req.page(html! {
                <Layout req={&req} title="Inventory Manager" chrome={chrome}>
                    <IntakeScreen screen={&screen} error={Some(&message)} />
                </Layout>
            })
        }
    }
}

#[derive(Deserialize, Fields)]
pub struct ClearInput {
    pub submit: SubmitKey,
}

/// The submit key of the table's form without JavaScript, whose other fields are named by SKU.
#[derive(Deserialize, Fields)]
#[expect(
    dead_code,
    reason = "the struct only names the key's field; the form is read as a map of SKUs"
)]
pub struct CountsKey {
    pub submit: SubmitKey,
}

/// Every count not yet queued removed; queued batches keep theirs.
pub async fn clear(
    req: Req,
    State(legacy): State<Legacy>,
    Params(at): Params<url::ClearCounts>,
    Form(input): Form<ClearInput>,
) -> HtmlResult {
    pending::clear(&legacy, input.submit.as_str())
        .await
        .map_err(|message| corten::Error::new(message).with_status(StatusCode::BAD_GATEWAY))?;
    req.redirect(&url::InventoryManager {
        selection: at.selection,
    })
}
