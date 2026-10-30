use std::time::Duration;

use corten::{ClientZone, ReadAgain, prelude::*};

use super::{
    identity::{self, Record},
    inventory::{self, InventoryPage, Listing},
    research::{self, Workspace},
    url::{self, Choice},
    views::{EvidenceList, SlabScreen},
};
use crate::{
    database::Database,
    layout::{Chrome, Layout},
    legacy::Legacy,
    text::Msg,
    zone::Visitor,
};

/// How long the evidence list waits to read a queued or running refresh again.
pub const REFRESHING: Duration = Duration::from_secs(2);

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
    /// The certificate's research at the chosen grade and dates, once it has an identity to
    /// research, or why it could not be read.
    pub research: Option<Result<Workspace, String>>,
    /// Whose time zone dates are written in.
    pub visitor: Visitor,
    /// Why the last post was refused.
    pub problem: Option<String>,
}

impl Screen {
    pub async fn read(
        db: &Database,
        legacy: &Legacy,
        choice: &Choice,
        visitor: Visitor,
    ) -> corten::Result<Screen> {
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
        let research = match record.as_ref().filter(|r| r.shown().is_some()) {
            Some(record) => Some(read_research(legacy, &record.id, choice).await),
            None => None,
        };
        Ok(Screen {
            choice: choice.clone(),
            record,
            inventory,
            listing,
            research,
            visitor,
            problem: None,
        })
    }

    /// A refresh is queued or running.
    pub fn refreshing(&self) -> bool {
        matches!(&self.research, Some(Ok(w)) if w.pending())
    }
}

/// The slab's research, with the refreshes on their way read where they stand (which keeps the
/// Node app's worker running them).
async fn read_research(legacy: &Legacy, id: &str, choice: &Choice) -> Result<Workspace, String> {
    let mut workspace = research::read(legacy, id, choice.grade(), &choice.window()).await?;
    if workspace.pending() {
        workspace.statuses = research::statuses(legacy, &workspace.keys).await?;
    }
    Ok(workspace)
}

pub async fn show(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::SlabPricing>,
) -> HtmlResult {
    let screen = Screen::read(&db, &legacy, &at.choice, Visitor::of(zone.as_ref())).await?;
    page(&req, &db, &screen).await
}

/// The evidence list as it stands, read again while a refresh is on its way.
pub async fn evidence(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::Evidence>,
) -> HtmlResult {
    let screen = Screen::read(&db, &legacy, &at.choice, Visitor::of(zone.as_ref())).await?;
    let t: Msg = req.t();
    let list = html! { <EvidenceList screen={&screen} t={t} /> };
    req.patch_or(list, || async { page(&req, &db, &screen).await })
        .await
}

pub async fn page(req: &Req, db: &Database, screen: &Screen) -> HtmlResult {
    let chrome = Chrome::read(db).await;
    let t: Msg = req.t();
    // Without JavaScript the whole page is read again; with it, only the evidence list is.
    let again = screen
        .refreshing()
        .then_some(ReadAgain { after: REFRESHING });
    req.page(html! {
        <Layout req={req} title="Slab Pricing" chrome={chrome} head={again}>
            <SlabScreen screen={screen} t={t} />
        </Layout>
    })
}
