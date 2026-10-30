use corten::prelude::*;

use super::{
    identity::{self, Record},
    inventory::{self, InventoryPage, Listing},
    url::{self, Choice},
    views::SlabScreen,
};
use crate::{
    database::Database,
    layout::{Chrome, Layout},
    legacy::Legacy,
};

/// The page as its address draws it.
pub struct Screen {
    pub choice: Choice,
    /// The certificate's saved identity: none when none is chosen, `Ok(None)` when it was never
    /// looked up.
    pub record: Option<Record>,
    /// The seller's listings on this page, or why they could not be read.
    pub inventory: Option<Result<InventoryPage, String>>,
    /// The listing being reviewed, when it is on this page.
    pub listing: Option<Listing>,
    /// Why the last post was refused.
    pub problem: Option<String>,
}

impl Screen {
    pub async fn read(db: &Database, legacy: &Legacy, choice: &Choice) -> corten::Result<Screen> {
        let record = match choice.certificate() {
            Some((grader, cert)) => identity::find(db, grader, cert).await?,
            None => None,
        };
        let inventory = match choice.seller.as_deref().filter(|s| !s.trim().is_empty()) {
            Some(seller) => {
                Some(inventory::page(legacy, seller, choice.after.as_deref().unwrap_or("")).await)
            }
            None => None,
        };
        let listing = choice.listing.as_deref().and_then(|id| {
            inventory
                .as_ref()
                .and_then(|i| i.as_ref().ok())
                .and_then(|page| page.items.iter().find(|l| l.id == id))
                .cloned()
        });
        Ok(Screen {
            choice: choice.clone(),
            record,
            inventory,
            listing,
            problem: None,
        })
    }
}

pub async fn show(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    Params(at): Params<url::SlabPricing>,
) -> HtmlResult {
    let screen = Screen::read(&db, &legacy, &at.choice).await?;
    page(&req, &db, &screen).await
}

pub async fn page(req: &Req, db: &Database, screen: &Screen) -> HtmlResult {
    let chrome = Chrome::read(db).await;
    req.page(html! {
        <Layout req={req} title="Slab Pricing" chrome={chrome} head="">
            <SlabScreen screen={screen} />
        </Layout>
    })
}
