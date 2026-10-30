//! The screen's posts. Each asks the Node app to do the work, then sends the browser back to the
//! page the post came from (its address is the post's query), showing what changed; a refusal
//! is that page with why, as a conflict.
// A refusal sets its status on the drawn page by hand (corten#438), and every post takes the
// visitor's zone only so a refusal can draw the page's dates (corten#387).
use corten::{ClientZone, Mode, SubmitKey, axum::http::StatusCode, prelude::*};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{
    identity::{self, Card, Grading, SlabIdentity},
    inventory, maintenance,
    outcomes::Imported,
    page::{Place, Screen, page},
    recommendation::{Fees, Policy, Seller},
    url::{self, Choice},
    views::Problem,
};
use crate::{database::Database, legacy::Legacy, zone::Visitor};

#[derive(Debug, Default, Deserialize, Fields)]
pub struct LookUpInput {
    #[serde(default)]
    pub grader: String,
    #[serde(default)]
    pub cert: String,
}

/// The certificate the Node app saved, as it normalized it.
#[derive(Deserialize)]
struct Looked {
    record: Saved,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    grader: String,
    certificate_number: String,
}

/// Looks the certificate up (its saved identity, or the provider's when there is none) and shows
/// it.
pub async fn look_up(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::LookUp>,
    Form(input): Form<LookUpInput>,
) -> HtmlResult {
    let asked = json!({ "intent": "lookup", "grader": input.grader.trim(), "certificateNumber": input.cert.trim() });
    match legacy
        .send::<_, Looked>("/api/slab-identities", &asked)
        .await
    {
        Ok(looked) => req.redirect(&url::SlabPricing::at(
            &at.choice
                .with_certificate(&looked.record.grader, &looked.record.certificate_number),
        )),
        Err(why) => {
            let choice = at
                .choice
                .with_certificate(input.grader.trim(), input.cert.trim());
            refused(
                Place::LookUp,
                &req,
                &db,
                &legacy,
                Visitor::of(zone.as_ref()),
                &choice,
                why,
            )
            .await
        }
    }
}

/// The physical slab's card and grade as the operator confirms them. Blank fields stay unknown.
#[derive(Debug, Default, Deserialize, Fields)]
pub struct ConfirmInput {
    pub revision: i64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub game: String,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub set: String,
    #[serde(default)]
    pub card_number: String,
    #[serde(default)]
    pub year: String,
    #[serde(default)]
    pub edition: String,
    #[serde(default)]
    pub finish: String,
    #[serde(default)]
    pub stamp: String,
    #[serde(default)]
    pub encoding: String,
    /// A half-grade from 1 to 10, or empty when the grade maps to no number.
    #[serde(default)]
    pub number: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub qualifier: String,
    #[serde(default)]
    pub autograph: String,
    #[serde(default)]
    pub note: String,
}

fn text(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

impl ConfirmInput {
    /// The identity as the Node app reads it, keeping the provider asset the record matched.
    fn identity(&self, grader: &str, kept: Option<&SlabIdentity>) -> SlabIdentity {
        let c = self;
        SlabIdentity {
            card: Card {
                name: text(&c.name),
                game: text(&c.game),
                language: text(&c.language),
                set: text(&c.set),
                card_number: text(&c.card_number),
                year: text(&c.year),
                edition: text(&c.edition),
                finish: text(&c.finish),
                stamp: text(&c.stamp),
            },
            grading: Grading {
                grader: grader.to_owned(),
                encoding: self.encoding.trim().to_owned(),
                number: self.number.trim().parse().ok(),
                label: text(&self.label),
                qualifier: text(&self.qualifier),
                autograph: text(&self.autograph),
            },
            provider_asset: kept.and_then(|k| k.provider_asset.clone()),
        }
    }
}

pub async fn confirm(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::Confirm>,
    Form(input): Form<ConfirmInput>,
) -> HtmlResult {
    let Some((grader, cert)) = at.choice.certificate() else {
        return refused(
            Place::Identity,
            &req,
            &db,
            &legacy,
            Visitor::of(zone.as_ref()),
            &at.choice,
            "Look up a certificate first.".into(),
        )
        .await;
    };
    let record = identity::find(&db, grader, cert).await?;
    let asked = json!({
        "intent": "confirm",
        "grader": grader,
        "certificateNumber": cert,
        "revision": input.revision,
        "identity": input.identity(grader, record.as_ref().and_then(|r| r.shown())),
        "note": input.note.trim(),
    });
    match legacy
        .send::<_, serde_json::Value>("/api/slab-identities", &asked)
        .await
    {
        Ok(_) => req.redirect(&url::SlabPricing::at(&at.choice)),
        Err(why) => {
            refused(
                Place::Identity,
                &req,
                &db,
                &legacy,
                Visitor::of(zone.as_ref()),
                &at.choice,
                why,
            )
            .await
        }
    }
}

#[derive(Debug, Deserialize, Fields)]
pub struct OpenInput {
    pub id: String,
}

/// Opens a listing for review: its identity's certificate, the one its listing names (resolved
/// with the provider when it has none), or no certificate at all.
pub async fn open(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::Open>,
    Form(input): Form<OpenInput>,
) -> HtmlResult {
    let seller = at.choice.seller.clone().unwrap_or_default();
    let reviewing = Choice {
        listing: Some(input.id.clone()),
        ..at.choice.clone()
    };
    let found = inventory::page(&legacy, &seller, at.choice.after.as_deref().unwrap_or(""))
        .await
        .map(|page| page.items.into_iter().find(|l| l.id == input.id));
    let listing = match found {
        Ok(Some(listing)) => listing,
        Ok(None) => {
            return refused(
                Place::Inventory,
                &req,
                &db,
                &legacy,
                Visitor::of(zone.as_ref()),
                &at.choice,
                "Reload the listing; it is not on this page any more.".into(),
            )
            .await;
        }
        Err(why) => {
            return refused(
                Place::Inventory,
                &req,
                &db,
                &legacy,
                Visitor::of(zone.as_ref()),
                &at.choice,
                why,
            )
            .await;
        }
    };
    let looked = if let Some(tied) = &listing.identity {
        let asked = json!({ "intent": "lookup", "grader": tied.grader, "certificateNumber": tied.certificate_number });
        legacy
            .send::<_, Looked>("/api/slab-identities", &asked)
            .await
            .map(Some)
    } else if listing.snapshot.certificate.is_some() {
        let asked = json!({ "intent": "resolve-identity", "seller": listing.seller, "id": listing.id, "revision": listing.revision });
        legacy
            .send::<_, Option<Looked>>("/api/slab-inventory", &asked)
            .await
    } else {
        Ok(None)
    };
    match looked {
        Ok(Some(l)) => req.redirect(&url::SlabPricing::at(
            &reviewing.with_certificate(&l.record.grader, &l.record.certificate_number),
        )),
        // A listing whose identity was assigned by hand answers with no record: show it as it is.
        Ok(None) => req.redirect(&url::SlabPricing::at(&reviewing)),
        Err(why) => {
            refused(
                Place::Inventory,
                &req,
                &db,
                &legacy,
                Visitor::of(zone.as_ref()),
                &reviewing,
                why,
            )
            .await
        }
    }
}

#[derive(Debug, Default, Deserialize, Fields)]
pub struct AssignInput {
    #[serde(default)]
    pub note: String,
}

/// Ties the confirmed identity shown to the listing reviewed, with the reason.
pub async fn assign(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::Assign>,
    Form(input): Form<AssignInput>,
) -> HtmlResult {
    let screen = Screen::read(&db, &legacy, &at.choice, Visitor::of(zone.as_ref())).await?;
    let (Some(listing), Some(record)) = (&screen.listing, &screen.record) else {
        return refused(
            Place::Listing,
            &req,
            &db,
            &legacy,
            Visitor::of(zone.as_ref()),
            &at.choice,
            "Open a listing and look up a confirmed certificate first.".into(),
        )
        .await;
    };
    let asked = json!({
        "intent": "assign-identity",
        "seller": listing.seller,
        "id": listing.id,
        "revision": listing.revision,
        "identityId": record.id,
        "note": input.note.trim(),
    });
    match legacy
        .send::<_, serde_json::Value>("/api/slab-inventory", &asked)
        .await
    {
        Ok(_) => req.redirect(&url::SlabPricing::at(&at.choice)),
        Err(why) => {
            refused(
                Place::Listing,
                &req,
                &db,
                &legacy,
                Visitor::of(zone.as_ref()),
                &at.choice,
                why,
            )
            .await
        }
    }
}

#[derive(Debug, Default, Deserialize, Fields)]
pub struct ImportInput {
    /// The inventory's revision when the page was drawn: an import over a newer one is refused.
    pub revision: i64,
    #[serde(default)]
    pub csv: String,
}

/// Imports a CSV snapshot of some of the seller's listings, then shows the first page.
pub async fn import(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::Import>,
    Form(input): Form<ImportInput>,
) -> HtmlResult {
    #[derive(Serialize)]
    struct Asked<'a> {
        intent: &'static str,
        seller: &'a str,
        revision: i64,
        csv: &'a str,
    }
    let seller = at.choice.seller.as_deref().unwrap_or("");
    let asked = Asked {
        intent: "import-csv",
        seller,
        revision: input.revision,
        csv: &input.csv,
    };
    match legacy
        .send::<_, serde_json::Value>("/api/slab-inventory", &asked)
        .await
    {
        Ok(_) => req.redirect(&url::SlabPricing::at(&Choice {
            after: None,
            trail: Vec::new(),
            listing: None,
            ..at.choice.clone()
        })),
        Err(why) => {
            refused(
                Place::Inventory,
                &req,
                &db,
                &legacy,
                Visitor::of(zone.as_ref()),
                &at.choice,
                why,
            )
            .await
        }
    }
}

/// The certificate researched, at the revision the page showed: a refresh for an identity
/// changed since is refused.
#[derive(Debug, Default, Deserialize, Fields)]
pub struct RefreshInput {
    pub id: String,
    pub revision: i64,
}

/// Queues the evidence for the chosen grade and dates for refresh, fetched again even when what
/// is saved is fresh. The Node app's worker calls the providers; the page follows it.
pub async fn refresh(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::Refresh>,
    Form(input): Form<RefreshInput>,
) -> HtmlResult {
    let asked = json!({
        "intent": "research",
        "slabId": input.id,
        "identityRevision": input.revision,
        "grade": at.choice.grade(),
        "window": at.choice.window(),
        "force": true,
    });
    match legacy
        .send::<_, serde_json::Value>("/api/slab-evidence", &asked)
        .await
    {
        Ok(_) => req.redirect(&url::SlabPricing::at(&at.choice)),
        Err(why) => {
            refused(
                Place::Research,
                &req,
                &db,
                &legacy,
                Visitor::of(zone.as_ref()),
                &at.choice,
                why,
            )
            .await
        }
    }
}

/// A refresh to stop, by its run: one that has been run again since is left alone.
#[derive(Debug, Default, Deserialize, Fields)]
pub struct CancelInput {
    pub key: String,
    pub run: String,
}

pub async fn cancel(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::Cancel>,
    Form(input): Form<CancelInput>,
) -> HtmlResult {
    let asked = json!({ "intent": "cancel", "key": input.key, "runId": input.run });
    match legacy
        .send::<_, serde_json::Value>("/api/slab-evidence", &asked)
        .await
    {
        Ok(_) => req.redirect(&url::SlabPricing::at(&at.choice)),
        Err(why) => {
            refused(
                Place::Research,
                &req,
                &db,
                &legacy,
                Visitor::of(zone.as_ref()),
                &at.choice,
                why,
            )
            .await
        }
    }
}

/// The seller's costs and the comparable price basis. A blank amount stays unknown.
#[derive(Debug, Default, Deserialize, Fields)]
pub struct CalculateInput {
    #[serde(default)]
    pub basis: String,
    pub current_ask: Option<f64>,
    pub shipping_charged: Option<f64>,
    pub shipping_cost: Option<f64>,
    pub acquisition_cost: Option<f64>,
    pub minimum_ask: Option<f64>,
    pub minimum_profit: Option<f64>,
    /// A percentage: 13.25 for 13.25%.
    pub fee_rate: Option<f64>,
    pub fee_fixed: Option<f64>,
    #[serde(default)]
    pub fee_basis: String,
}

impl CalculateInput {
    /// The costs as the Node app reads them, or why they cannot be.
    fn seller(&self) -> Result<Seller, String> {
        let fees = match (self.fee_rate, self.fee_fixed) {
            (Some(rate), Some(fixed)) => Some(Fees {
                rate: rate / 100.0,
                fixed,
                basis: self.fee_basis.clone(),
            }),
            (None, None) => None,
            _ => {
                return Err(
                    "Provide both fee percentage and fixed fee, or leave both unknown.".into(),
                );
            }
        };
        Ok(Seller {
            current_ask: self.current_ask,
            shipping_charged: self.shipping_charged,
            shipping_cost: self.shipping_cost,
            acquisition_cost: self.acquisition_cost,
            minimum_ask: self.minimum_ask,
            minimum_profit: self.minimum_profit,
            fees,
        })
    }
}

/// Queues the active supply for the grade and dates for refresh, then shows its default source
/// from its first row.
pub async fn refresh_supply(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::RefreshSupply>,
    Form(input): Form<RefreshInput>,
) -> HtmlResult {
    let visitor = Visitor::of(zone.as_ref());
    let screen = Screen::read(&db, &legacy, &at.choice, visitor).await?;
    let asked = json!({
        "intent": "refresh",
        "slabId": input.id,
        "identityRevision": input.revision,
        "grade": at.choice.grade(),
        "window": at.choice.window(),
        "seller": screen.supply_seller(),
    });
    match legacy
        .send::<_, serde_json::Value>("/api/slab-supply", &asked)
        .await
    {
        Ok(_) => req.redirect(&url::SlabPricing::at(
            &at.choice.supply_source(None, Vec::new()),
        )),
        Err(why) => refused(Place::Supply, &req, &db, &legacy, visitor, &at.choice, why).await,
    }
}

/// The eBay source page shown, whose next page is fetched.
#[derive(Debug, Default, Deserialize, Fields)]
pub struct NextSourcePageInput {
    pub revision: String,
}

#[derive(Deserialize)]
struct Queued {
    statuses: Vec<QueuedStatus>,
}

#[derive(Deserialize)]
struct QueuedStatus {
    key: String,
}

/// Queues the next page of the eBay supply source shown, then shows it, keeping the way back.
pub async fn next_source_page(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::NextSourcePage>,
    Form(input): Form<NextSourcePageInput>,
) -> HtmlResult {
    let asked = json!({ "intent": "next-page", "revision": input.revision });
    match legacy.send::<_, Queued>("/api/slab-evidence", &asked).await {
        Ok(queued) => {
            let Some(next) = queued.statuses.into_iter().next() else {
                return req.redirect(&url::SlabPricing::at(&at.choice));
            };
            // The default source is kept as an empty entry, as the first listing page is.
            let mut sources = at.choice.sources.clone();
            sources.push(at.choice.source.clone().unwrap_or_default());
            req.redirect(&url::SlabPricing::at(
                &at.choice.supply_source(Some(next.key), sources),
            ))
        }
        Err(why) => {
            let visitor = Visitor::of(zone.as_ref());
            refused(Place::Supply, &req, &db, &legacy, visitor, &at.choice, why).await
        }
    }
}

/// The seller's maintenance settings, at the revision the form was drawn from.
#[derive(Debug, Default, Deserialize, Fields)]
pub struct MaintenanceInput {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub include_supply: bool,
    pub interval_minutes: i64,
    pub batch_size: i64,
    pub refresh_budget: i64,
    pub revision: i64,
}

/// Saves the seller's maintenance settings. Enabling them starts the Node app's worker on its
/// cycles; it never publishes.
pub async fn save_maintenance(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::SaveMaintenance>,
    Form(input): Form<MaintenanceInput>,
) -> HtmlResult {
    let settings = maintenance::Saved {
        seller: at.choice.seller.as_deref().unwrap_or(""),
        enabled: input.enabled,
        include_supply: input.include_supply,
        interval_minutes: input.interval_minutes,
        batch_size: input.batch_size,
        refresh_budget: input.refresh_budget,
        revision: input.revision,
    };
    let asked = json!({ "intent": "save", "settings": settings });
    match legacy
        .send::<_, serde_json::Value>("/api/slab-maintenance", &asked)
        .await
    {
        Ok(_) => req.redirect(&url::SlabPricing::at(&at.choice)),
        Err(why) => {
            let visitor = Visitor::of(zone.as_ref());
            refused(
                Place::Maintenance,
                &req,
                &db,
                &legacy,
                visitor,
                &at.choice,
                why,
            )
            .await
        }
    }
}

#[derive(Debug, Default, Deserialize, Fields)]
pub struct OutcomesInput {
    #[serde(default)]
    pub csv: String,
}

/// Imports reviewed outcomes for the seller's listings, then shows the first listing's.
pub async fn import_outcomes(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::ImportOutcomes>,
    Form(input): Form<OutcomesInput>,
) -> HtmlResult {
    let seller = at.choice.seller.as_deref().unwrap_or("");
    let asked = json!({ "intent": "import-csv", "seller": seller, "csv": input.csv });
    match legacy
        .send::<_, Imported>("/api/slab-outcomes", &asked)
        .await
    {
        Ok(imported) => req.redirect(&url::SlabPricing::at(&Choice {
            item: imported
                .item_ids
                .into_iter()
                .next()
                .or(at.choice.item.clone()),
            inserted: Some(imported.inserted),
            supplied: Some(imported.supplied),
            ..at.choice.clone()
        })),
        Err(why) => {
            let visitor = Visitor::of(zone.as_ref());
            refused(
                Place::Outcomes,
                &req,
                &db,
                &legacy,
                visitor,
                &at.choice,
                why,
            )
            .await
        }
    }
}

/// Calculates the owned slab's recommendation from the evidence saved for the dates shown.
pub async fn calculate(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::Calculate>,
    Form(input): Form<CalculateInput>,
) -> HtmlResult {
    let visitor = Visitor::of(zone.as_ref());
    let screen = Screen::read(&db, &legacy, &at.choice, visitor).await?;
    let (Some(record), Some(revisions)) = (&screen.record, screen.calculable_revisions()) else {
        let why = "Confirm the owned identity, assign it to the selected listing if needed, and return to its grade to calculate.";
        return refused(
            Place::Recommendation,
            &req,
            &db,
            &legacy,
            visitor,
            &at.choice,
            why.into(),
        )
        .await;
    };
    let mut seller = match input.seller() {
        Ok(seller) => json!(seller),
        Err(why) => {
            return refused(
                Place::Recommendation,
                &req,
                &db,
                &legacy,
                visitor,
                &at.choice,
                why,
            )
            .await;
        }
    };
    seller["currency"] = "USD".into();
    let asked = json!({
        "intent": "calculate",
        "slabId": record.id,
        "identityRevision": record.revision,
        "revisionIds": revisions,
        "policy": Policy::with_basis(&input.basis),
        "seller": seller,
    });
    match legacy
        .send::<_, serde_json::Value>("/api/slab-recommendations", &asked)
        .await
    {
        Ok(_) => req.redirect(&url::SlabPricing::at(&at.choice)),
        Err(why) => {
            refused(
                Place::Recommendation,
                &req,
                &db,
                &legacy,
                visitor,
                &at.choice,
                why,
            )
            .await
        }
    }
}

/// The ask the operator settled on for the latest recommendation, and why.
#[derive(Debug, Default, Deserialize, Fields)]
pub struct ReviewAskInput {
    pub recommendation: String,
    pub item_price: Option<f64>,
    #[serde(default)]
    pub note: String,
}

pub async fn review_ask(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::ReviewAsk>,
    Form(input): Form<ReviewAskInput>,
) -> HtmlResult {
    let asked = json!({
        "intent": "override",
        "recommendationId": input.recommendation,
        "itemPrice": input.item_price,
        "currency": "USD",
        "note": input.note.trim(),
    });
    match legacy
        .send::<_, serde_json::Value>("/api/slab-recommendations", &asked)
        .await
    {
        Ok(_) => req.redirect(&url::SlabPricing::at(&at.choice)),
        Err(why) => {
            refused(
                Place::Recommendation,
                &req,
                &db,
                &legacy,
                Visitor::of(zone.as_ref()),
                &at.choice,
                why,
            )
            .await
        }
    }
}

/// The price to review (`calculated` or `reviewed`) of the listing and recommendation as the
/// page showed them: a listing revised or an ask reviewed again since is refused.
#[derive(Debug, Deserialize, Fields)]
pub struct PrepareInput {
    /// Sent as the preview's intent, so a post sent again saves one preview.
    pub submit: SubmitKey,
    pub revision: i64,
    pub recommendation: String,
    #[serde(default)]
    pub reviewed_at: String,
    #[serde(default)]
    pub selection: String,
}

/// Saves a price-change preview of the listing reviewed: the selected ask with the listing and
/// its evidence. It writes nothing to eBay.
pub async fn prepare(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::Prepare>,
    Form(input): Form<PrepareInput>,
) -> HtmlResult {
    let visitor = Visitor::of(zone.as_ref());
    let screen = Screen::read(&db, &legacy, &at.choice, visitor).await?;
    let fresh = screen.can_calculate() && screen.recommendation().is_some() && !screen.stale();
    let Some(listing) = screen.listing.as_ref().filter(|_| fresh) else {
        let why = "Recalculate using the current listing and evidence before preparing another price change.";
        return refused(
            Place::Publication,
            &req,
            &db,
            &legacy,
            visitor,
            &at.choice,
            why.into(),
        )
        .await;
    };
    let reviewed = input.selection == "reviewed";
    let asked = json!({
        "intent": "prepare",
        "intentId": input.submit.as_str(),
        "inventoryId": listing.id,
        "inventoryRevision": input.revision,
        "recommendationId": input.recommendation,
        "selection": input.selection,
        "overrideReviewedAt": reviewed.then_some(input.reviewed_at.as_str()),
    });
    match legacy
        .send::<_, serde_json::Value>("/api/slab-publication-previews", &asked)
        .await
    {
        Ok(_) => req.redirect(&url::SlabPricing::at(&Choice {
            steps: None,
            ..at.choice.clone()
        })),
        Err(why) => {
            refused(
                Place::Publication,
                &req,
                &db,
                &legacy,
                visitor,
                &at.choice,
                why,
            )
            .await
        }
    }
}

/// The preview whose publication runs without writing. A new run's intent is a fresh key; a
/// stopped one is resumed with its own id.
#[derive(Debug, Deserialize, Fields)]
pub struct DryRunInput {
    pub intent: SubmitKey,
    pub preview: String,
}

#[derive(Deserialize)]
struct Ran {
    id: String,
}

/// Checks the preview's plan against the imported inventory and records the outcome, then shows
/// its steps. It does not contact eBay or change a price.
pub async fn dry_run(
    req: Req,
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    zone: Option<ClientZone>,
    Params(at): Params<url::DryRun>,
    Form(input): Form<DryRunInput>,
) -> HtmlResult {
    let asked = json!({ "intent": "dry-run", "intentId": input.intent.as_str(), "previewId": input.preview });
    match legacy
        .send::<_, Ran>("/api/slab-publications", &asked)
        .await
    {
        Ok(ran) => req.redirect(&url::SlabPricing::at(&Choice {
            steps: Some(ran.id),
            ..at.choice.clone()
        })),
        Err(why) => {
            let visitor = Visitor::of(zone.as_ref());
            refused(Place::DryRun, &req, &db, &legacy, visitor, &at.choice, why).await
        }
    }
}

/// Why the post was refused, as a conflict, in the part of the page that sent it: with
/// JavaScript (a `data-patch` form) only that part's message, so what the user typed stays;
/// otherwise the page the post came from.
async fn refused(
    at: Place,
    req: &Req,
    db: &Database,
    legacy: &Legacy,
    visitor: Visitor,
    choice: &Choice,
    why: String,
) -> HtmlResult {
    if req.mode == Mode::Action {
        let why = Some(why.as_str());
        return req.patch_with_status(
            StatusCode::CONFLICT,
            html! { <Problem at={at} why={why} /> },
        );
    }
    let mut screen = Screen::read(db, legacy, choice, visitor).await?;
    screen.problem = Some((at, why));
    let mut answer = page(req, db, &screen).await?;
    *answer.status_mut() = StatusCode::CONFLICT;
    Ok(answer)
}
