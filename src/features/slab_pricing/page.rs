use std::{collections::BTreeSet, time::Duration};

use corten::{ClientZone, ReadAgain, prelude::*};

use super::{
    identity::{self, Record},
    inventory::{self, InventoryPage, Listing},
    maintenance, outcomes,
    research::{self, Workspace},
    supply::{self, DEFAULT_SELLER, Supply},
    url::{self, Choice},
    views::{EvidenceList, MaintenanceStatusPart, SlabScreen, SupplyBody},
};
use crate::{
    database::Database,
    layout::{Chrome, Layout},
    legacy::Legacy,
    text::Msg,
    zone::Visitor,
};

/// The most evidence revisions one calculation reads, as the Node app allows.
const MOST_REVISIONS: usize = 20;

/// How long the evidence list waits to read a queued or running refresh again.
pub const REFRESHING: Duration = Duration::from_secs(2);

/// The parts of the screen a post comes from, where its refusal is shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Place {
    LookUp,
    Identity,
    Listing,
    Inventory,
    Research,
    Supply,
    Recommendation,
    Maintenance,
    Outcomes,
}

impl Place {
    /// The part's name in its message's element id.
    pub fn name(self) -> &'static str {
        match self {
            Place::LookUp => "look-up",
            Place::Identity => "identity",
            Place::Listing => "listing",
            Place::Inventory => "inventory",
            Place::Research => "research",
            Place::Supply => "supply",
            Place::Maintenance => "maintenance",
            Place::Outcomes => "outcomes",
            Place::Recommendation => "recommendation",
        }
    }
}

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
    /// The active supply for the slab, when it is shown, or why it could not be read.
    pub supply: Option<Result<Supply, String>>,
    /// The seller's evidence maintenance, when it is shown.
    pub maintenance: Option<Result<maintenance::View, String>>,
    /// The outcomes of the listing asked about, when the seller's outcomes are shown.
    pub outcomes: Option<Result<outcomes::Review, String>>,
    /// Whose time zone dates are written in.
    pub visitor: Visitor,
    /// Why the last post was refused, and the part of the page that sent it.
    pub problem: Option<(Place, String)>,
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
        let supply = match (&record, &research) {
            (Some(record), Some(Ok(_))) if choice.shows_supply() => {
                let seller = listing
                    .as_ref()
                    .map_or(DEFAULT_SELLER, |l| l.seller.as_str());
                let window = choice.window();
                let asked = supply::Asked {
                    id: &record.id,
                    grade: choice.grade(),
                    window: &window,
                    seller,
                    source: choice.source.as_deref(),
                    offset: choice.rows.unwrap_or(0),
                };
                Some(supply::read(legacy, &asked).await)
            }
            _ => None,
        };
        let seller = choice.seller.as_deref().filter(|s| !s.trim().is_empty());
        let maintenance = match seller {
            Some(seller) if choice.maintenance == Some(true) => {
                Some(maintenance::read(legacy, seller).await)
            }
            _ => None,
        };
        let outcomes = match (seller, choice.item.as_deref()) {
            (Some(seller), Some(item))
                if choice.outcomes == Some(true) && !item.trim().is_empty() =>
            {
                Some(outcomes::read(legacy, seller, item.trim()).await)
            }
            _ => None,
        };
        Ok(Screen {
            choice: choice.clone(),
            record,
            inventory,
            listing,
            research,
            supply,
            maintenance,
            outcomes,
            visitor,
            problem: None,
        })
    }

    /// Why a post from `place` was refused, when it was.
    pub fn problem_at(&self, place: Place) -> Option<&str> {
        self.problem
            .as_ref()
            .filter(|(at, _)| *at == place)
            .map(|(_, why)| why.as_str())
    }

    /// A refresh of the evidence or the supply shown is queued or running.
    pub fn refreshing(&self) -> bool {
        matches!(&self.research, Some(Ok(w)) if w.pending())
            || matches!(&self.supply, Some(Ok(s)) if s.pending())
    }

    /// The seller whose own listings supply leaves out: the listing reviewed's, or the default.
    pub fn supply_seller(&self) -> &str {
        self.listing
            .as_ref()
            .map_or(DEFAULT_SELLER, |l| l.seller.as_str())
    }

    /// The owned slab can be calculated: its identity is confirmed, the owned grade is shown,
    /// the listing reviewed (if any) is tied to it, and its evidence is read and not too much.
    pub fn can_calculate(&self) -> bool {
        let (Some(record), Some(Ok(workspace))) = (&self.record, &self.research) else {
            return false;
        };
        let tied = self.choice.listing.is_none()
            || self.listing.as_ref().and_then(|l| l.identity_id.as_deref())
                == Some(record.id.as_str());
        record.confirmed()
            && self.choice.grade() == "owned"
            && tied
            && workspace.latest_revisions().len() <= MOST_REVISIONS
    }

    /// The evidence a calculation would read now, when one can be made.
    pub fn calculable_revisions(&self) -> Option<BTreeSet<String>> {
        match &self.research {
            Some(Ok(workspace)) if self.can_calculate() => Some(workspace.latest_revisions()),
            _ => None,
        }
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

/// The seller's maintenance status as it stands, read again while maintenance is enabled.
pub async fn maintenance_status(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::MaintenanceStatus>,
) -> HtmlResult {
    let screen = Screen::read(&db, &legacy, &at.choice, Visitor::of(zone.as_ref())).await?;
    let t: Msg = req.t();
    // The markup moves the locals it uses (corten#414).
    let screen = &screen;
    let status = html! { <MaintenanceStatusPart screen={screen} t={t} /> };
    req.patch_or(status, || async { page(&req, &db, screen).await })
        .await
}

/// The evidence list (and the supply, when shown) as it stands, read again while a refresh is
/// on its way.
pub async fn evidence(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::Evidence>,
) -> HtmlResult {
    let screen = Screen::read(&db, &legacy, &at.choice, Visitor::of(zone.as_ref())).await?;
    let t: Msg = req.t();
    // The markup moves the locals it uses (corten#414).
    let screen = &screen;
    let list = html! {
        <EvidenceList screen={screen} t={t} />
        if screen.choice.shows_supply() {
            <SupplyBody screen={screen} t={t} />
        }
    };
    req.patch_or(list, || async { page(&req, &db, screen).await })
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
