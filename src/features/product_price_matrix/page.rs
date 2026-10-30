use corten::{ClientZone, prelude::*};

use super::{
    matrix::{self, Matrix},
    products::{self, Product},
    url,
    views::MatrixScreen,
};
use crate::{
    database::Database,
    features::inventory_intake::catalog::{self, ProductLine, ProductType, Scope, Set},
    layout::{Chrome, Layout},
    legacy::Legacy,
    text::Msg,
    zone::Visitor,
};

/// The page as the choices in its address draw it.
pub struct Screen {
    pub lines: Vec<ProductLine>,
    pub line: i32,
    pub sets: Vec<Set>,
    pub set: Option<i32>,
    pub scope: Scope,
    pub number: String,
    pub product_type: ProductType,
    /// The products to choose from, or why they could not be read.
    pub products: Result<Vec<Product>, String>,
    /// Each product to choose from as the picker offers it: its id and label.
    pub choices: Vec<(String, String)>,
    pub product: Option<Product>,
    /// The chosen product's id, as the picker's value.
    pub chosen: Option<String>,
    pub language: Option<String>,
    /// The chosen product's prices, or why they could not be read.
    pub matrix: Option<Result<Matrix, String>>,
}

impl Screen {
    async fn read(db: &Database, legacy: &Legacy, choice: &url::Choice) -> corten::Result<Screen> {
        let lines = catalog::product_lines(db).await?;
        let line = choice
            .line
            .filter(|l| lines.iter().any(|known| known.id == *l))
            .unwrap_or(catalog::DEFAULT_PRODUCT_LINE);
        let sets = catalog::sets(db, line).await?;
        let set = choice
            .set
            .filter(|s| sets.iter().any(|known| known.id == *s))
            .or_else(|| sets.first().map(|s| s.id));
        let scope = choice.scope.unwrap_or_default();
        let number = choice.number.as_deref().unwrap_or("").trim().to_owned();
        let product_type = choice.product_type.unwrap_or_default();
        let products = match products::looking(scope, set, &number) {
            Some(looking) => products::products(legacy, line, looking, product_type).await,
            None => Ok(Vec::new()),
        };
        let product = products
            .as_ref()
            .ok()
            .and_then(|all| all.iter().find(|p| Some(p.product_id) == choice.product))
            .cloned();
        // A product chosen anew opens in its own language, as the React screen opened it.
        let kept = choice
            .language
            .as_deref()
            .filter(|_| choice.shown_product == choice.product);
        let language = product
            .as_ref()
            .and_then(|p| p.language(kept))
            .map(str::to_owned);
        let suggested = choice.suggested.unwrap_or(false);
        let choices = products
            .as_ref()
            .map(|all| {
                all.iter()
                    .map(|p| (p.product_id.to_string(), p.label()))
                    .collect()
            })
            .unwrap_or_default();
        let chosen = product.as_ref().map(|p| p.product_id.to_string());
        let matrix = match &product {
            Some(p) => Some(matrix::matrix(legacy, p, language.as_deref(), suggested).await),
            None => None,
        };
        Ok(Screen {
            lines,
            line,
            sets,
            set,
            scope,
            number,
            product_type,
            products,
            choices,
            product,
            chosen,
            language,
            matrix,
        })
    }

    /// The address of this product priced again: by market alone, or with the policy's prices.
    pub fn priced(&self, suggested: bool) -> url::ProductPriceMatrix {
        url::ProductPriceMatrix {
            choice: url::Choice {
                line: Some(self.line),
                set: self.set,
                scope: Some(self.scope),
                number: (!self.number.is_empty()).then(|| self.number.clone()),
                product_type: Some(self.product_type),
                product: self.product.as_ref().map(|p| p.product_id),
                shown_product: self.product.as_ref().map(|p| p.product_id),
                language: self.language.clone(),
                suggested: suggested.then_some(true),
            },
        }
    }
}

pub async fn show(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::ProductPriceMatrix>,
) -> HtmlResult {
    let visitor = Visitor::of(zone.as_ref());
    let (chrome, screen) = tokio::join!(Chrome::read(&db), Screen::read(&db, &legacy, &at.choice));
    let screen = screen?;
    let t: Msg = req.t();
    req.page(html! {
        <Layout req={&req} title="Product Price Matrix" chrome={chrome} head="">
            <MatrixScreen screen={&screen} visitor={visitor} t={t} />
        </Layout>
    })
}
