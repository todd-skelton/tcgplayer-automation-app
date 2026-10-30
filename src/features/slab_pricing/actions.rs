//! The screen's posts. Each asks the Node app to do the work, then sends the browser back to the
//! page the post came from (its address is the post's query), showing what changed; a refusal
//! is that page with why, as a conflict.
// A refusal sets its status on the drawn page by hand (corten#438), and every post takes the
// visitor's zone only so a refusal can draw the page's dates (corten#387).
use corten::{ClientZone, axum::http::StatusCode, prelude::*};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{
    identity::{self, Card, Grading, SlabIdentity},
    inventory,
    page::{Screen, page},
    url::{self, Choice},
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
            refused(&req, &db, &legacy, Visitor::of(zone.as_ref()), &choice, why).await
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

/// The page the post came from, saying why it was refused, as a conflict.
async fn refused(
    req: &Req,
    db: &Database,
    legacy: &Legacy,
    visitor: Visitor,
    choice: &Choice,
    why: String,
) -> HtmlResult {
    let mut screen = Screen::read(db, legacy, choice, visitor).await?;
    screen.problem = Some(why);
    let mut answer = page(req, db, &screen).await?;
    *answer.status_mut() = StatusCode::CONFLICT;
    Ok(answer)
}
