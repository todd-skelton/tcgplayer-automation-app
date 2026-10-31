//! Slab Pricing: look up a graded card's certificate, confirm what it is, and work through the
//! seller's eBay listings that need a certificate or a review. Ported from
//! `app/features/ebay-slab-pricing/routes/slab-pricing.tsx` and its identity editor and
//! inventory panel.
//!
//! The certificate lookups, identity decisions and inventory imports stay the Node app's
//! (`/api/slab-identities`, `/api/slab-inventory`); this screen reads what they saved. What the
//! screen shows (the certificate, the seller, the page of listings, the listing being reviewed)
//! is its address, so each post carries it and sends the browser back to it.
//!
//! Research reads the evidence saved for the owned grade, or a PSA grade explored beside it, over
//! a window of sale dates. Refreshing it queues work for the Node app's worker, which calls eBay
//! and Alt; while a refresh is queued or running the evidence list reads itself again every two
//! seconds (`ReadAgain` from `GET /slab-pricing/evidence`, the whole page without JavaScript).
//!
//! The recommendation is calculated by the Node app from the saved evidence only. A saved one is
//! marked for recalculation when the Node app says it is no longer current, or when newer
//! evidence is saved than it read. The React panel also marked it while its inputs were being
//! edited; this one does not, so its reviewed ask can be saved over inputs changed but not
//! calculated.
//!
//! The supply context (asks on unsold listings, screened against the identity) is shown on
//! request (`supply=true`) and read again with the evidence while its refresh runs.
//!
//! Under the seller's inventory, evidence maintenance (its status read again every five seconds
//! while enabled) and seller outcomes are shown on request.
//!
//! Once a listing is reviewed and has a recommendation, its price change can be reviewed on
//! request (`publication=true`): a preview of the calculated or reviewed ask saved with the
//! listing and its evidence, then a dry run of its publication against the imported inventory.
//! Each post carries a `SubmitKey`, sent to the Node app as the intent, so a post sent again
//! applies once. Neither contacts eBay; publishing is not connected.
//!
//! The comps of a saved evidence revision are reviewed on request (`comps=<revision>`), fifty
//! sales a page, each screened against the identity researched by the Node app. A sale opens in a
//! dialog the address names (`comp=<row>`), where the operator includes or excludes it; that
//! marks the recommendation for recalculation. Fetching a sale's details or an eBay source's next
//! page adds its evidence beside the grade's own (`extra`).
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /slab-pricing` | the certificate's identity, the seller's listings, the listing reviewed |
//! | `POST /slab-pricing/look-up` | the certificate looked up, then the page for it |
//! | `POST /slab-pricing/confirm` | the identity confirmed or corrected, then the page |
//! | `POST /slab-pricing/open` | a listing's certificate resolved, then the page reviewing it |
//! | `POST /slab-pricing/assign` | the confirmed identity tied to the listing reviewed |
//! | `POST /slab-pricing/import` | a CSV snapshot of the seller's listings imported |
//! | `GET /slab-pricing/evidence` | the evidence list, as a patch (the page without JavaScript) |
//! | `POST /slab-pricing/refresh` | the evidence for the grade and window queued for refresh |
//! | `POST /slab-pricing/cancel` | a queued or running refresh cancelled |
//! | `POST /slab-pricing/refresh-supply` | the active supply for the grade and dates queued for refresh |
//! | `POST /slab-pricing/next-source-page` | the next page of an eBay source queued, then shown |
//! | `GET /slab-pricing/maintenance-status` | the seller's maintenance status, as a patch (the page without JavaScript) |
//! | `POST /slab-pricing/maintenance` | the seller's maintenance settings saved |
//! | `POST /slab-pricing/outcomes` | reviewed seller outcomes imported from CSV, then shown |
//! | `POST /slab-pricing/calculate` | the owned slab's recommendation calculated from saved evidence |
//! | `POST /slab-pricing/reviewed-ask` | the operator's reviewed ask saved on the latest recommendation |
//! | `POST /slab-pricing/prepare` | a price-change preview of the listing reviewed saved |
//! | `POST /slab-pricing/dry-run` | the preview's publication run without writing, then its steps shown |
//! | `POST /slab-pricing/comp-decision` | a sale included or excluded from the comps, and why |
//! | `POST /slab-pricing/fetch-comps` | a sale's details or an eBay source's next page queued, then shown beside the rest |
//!
//! A post the Node app refuses answers 409 with the page and why.
mod actions;
mod comps;
mod identity;
mod inventory;
mod maintenance;
mod outcomes;
mod page;
mod publication;
mod recommendation;
mod research;
mod supply;
mod views;

pub use views::COMPONENTS;

// Handlers are named from here, where the routes module is declared.
use actions::{
    assign, calculate, cancel, confirm, decide_comp, dry_run, fetch_comps, import, import_outcomes,
    look_up, next_source_page, open, prepare, refresh, refresh_supply, review_ask,
    save_maintenance,
};
use page::{evidence, maintenance_status, show};

#[corten::routes(area = SlabPricing, state = crate::app::Shared)]
pub mod url {
    use super::research::Window;
    #[route("/slab-pricing", get = show)]
    pub struct SlabPricing {
        #[route(query)]
        pub choice: Choice,
    }

    #[route("/slab-pricing/look-up", post = look_up)]
    pub struct LookUp {
        #[route(query)]
        pub choice: Choice,
    }

    #[route("/slab-pricing/confirm", post = confirm)]
    pub struct Confirm {
        #[route(query)]
        pub choice: Choice,
    }

    #[route("/slab-pricing/open", post = open)]
    pub struct Open {
        #[route(query)]
        pub choice: Choice,
    }

    #[route("/slab-pricing/assign", post = assign)]
    pub struct Assign {
        #[route(query)]
        pub choice: Choice,
    }

    #[route("/slab-pricing/import", post = import)]
    pub struct Import {
        #[route(query)]
        pub choice: Choice,
    }

    #[route("/slab-pricing/evidence", get = evidence)]
    pub struct Evidence {
        #[route(query)]
        pub choice: Choice,
    }

    #[route("/slab-pricing/refresh", post = refresh)]
    pub struct Refresh {
        #[route(query)]
        pub choice: Choice,
    }

    #[route("/slab-pricing/cancel", post = cancel)]
    pub struct Cancel {
        #[route(query)]
        pub choice: Choice,
    }

    #[route("/slab-pricing/refresh-supply", post = refresh_supply)]
    pub struct RefreshSupply {
        #[route(query)]
        pub choice: Choice,
    }

    #[route("/slab-pricing/next-source-page", post = next_source_page)]
    pub struct NextSourcePage {
        #[route(query)]
        pub choice: Choice,
    }

    #[route("/slab-pricing/maintenance-status", get = maintenance_status)]
    pub struct MaintenanceStatus {
        #[route(query)]
        pub choice: Choice,
    }

    #[route("/slab-pricing/maintenance", post = save_maintenance)]
    pub struct SaveMaintenance {
        #[route(query)]
        pub choice: Choice,
    }

    #[route("/slab-pricing/outcomes", post = import_outcomes)]
    pub struct ImportOutcomes {
        #[route(query)]
        pub choice: Choice,
    }

    #[route("/slab-pricing/calculate", post = calculate)]
    pub struct Calculate {
        #[route(query)]
        pub choice: Choice,
    }

    #[route("/slab-pricing/reviewed-ask", post = review_ask)]
    pub struct ReviewAsk {
        #[route(query)]
        pub choice: Choice,
    }

    #[route("/slab-pricing/prepare", post = prepare)]
    pub struct Prepare {
        #[route(query)]
        pub choice: Choice,
    }

    #[route("/slab-pricing/dry-run", post = dry_run)]
    pub struct DryRun {
        #[route(query)]
        pub choice: Choice,
    }

    #[route("/slab-pricing/comp-decision", post = decide_comp)]
    pub struct DecideComp {
        #[route(query)]
        pub choice: Choice,
    }

    #[route("/slab-pricing/fetch-comps", post = fetch_comps)]
    pub struct FetchComps {
        #[route(query)]
        pub choice: Choice,
    }

    /// What the screen shows: the certificate (`grader`, `cert`), the seller whose listings are
    /// open, the page of them (`after` the listing that ended the last page, `trail` the pages
    /// before it, for Previous), the listing being reviewed, and the grade and sale dates the
    /// certificate is researched at.
    #[derive(Clone, Debug, Default, serde::Deserialize, corten::Route, corten::Fields)]
    #[route(query)]
    pub struct Choice {
        pub grader: Option<String>,
        pub cert: Option<String>,
        pub seller: Option<String>,
        pub after: Option<String>,
        #[serde(default)]
        pub trail: Vec<String>,
        pub listing: Option<String>,
        /// `owned`, or a PSA grade explored beside the owned one.
        pub grade: Option<String>,
        pub from: Option<String>,
        pub to: Option<String>,
        /// The supply context is shown.
        pub supply: Option<bool>,
        /// The supply source shown (an evidence key), when not the default one.
        pub source: Option<String>,
        /// The first supply row shown.
        pub rows: Option<u32>,
        /// The supply sources shown before this one, for Previous source page.
        #[serde(default)]
        pub sources: Vec<String>,
        /// The seller's evidence maintenance is shown.
        pub maintenance: Option<bool>,
        /// The seller's outcomes are shown, and the listing whose outcomes are read.
        pub outcomes: Option<bool>,
        pub item: Option<String>,
        /// What the last outcome import saved: new observations, of rows supplied. Carried in
        /// the address because a redirect cannot say what it did (corten#385).
        pub inserted: Option<u32>,
        pub supplied: Option<u32>,
        /// The listing's price-change review is shown, and the publication whose steps are.
        pub publication: Option<bool>,
        pub steps: Option<String>,
        /// The evidence revision whose comps are reviewed, its first row shown, and the row
        /// (in the whole revision) open for a decision.
        pub comps: Option<String>,
        pub comps_from: Option<u32>,
        pub comp: Option<u32>,
        /// Evidence fetched beyond the grade's own (a sale's details, an eBay source's next
        /// page), shown and calculated with it.
        #[serde(default)]
        pub extra: Vec<String>,
    }

    impl Choice {
        /// The certificate shown, when both halves are given.
        pub fn certificate(&self) -> Option<(&str, &str)> {
            self.grader
                .as_deref()
                .zip(self.cert.as_deref())
                .filter(|(g, c)| !g.trim().is_empty() && !c.trim().is_empty())
        }

        /// This choice reviewing the comps of `revision` from its first row, none open.
        pub fn reviewing_comps(&self, revision: &str) -> Choice {
            Choice {
                comps: Some(revision.to_owned()),
                comps_from: None,
                comp: None,
                ..self.clone()
            }
        }

        /// This choice with `keys` fetched beside the grade's own evidence, no comp open.
        pub fn with_extra(&self, keys: impl IntoIterator<Item = String>) -> Choice {
            let mut extra = self.extra.clone();
            for key in keys {
                if !extra.contains(&key) {
                    extra.push(key);
                }
            }
            Choice {
                extra,
                comp: None,
                ..self.clone()
            }
        }

        /// The supply context is shown.
        pub fn shows_supply(&self) -> bool {
            self.supply == Some(true)
        }

        /// This choice on the first row of the supply source shown, or of `source`.
        pub fn supply_source(&self, source: Option<String>, sources: Vec<String>) -> Choice {
            Choice {
                source,
                sources,
                rows: None,
                ..self.clone()
            }
        }

        /// The supply source shown before this one, if there is one.
        pub fn previous_source(&self) -> Option<Choice> {
            let mut sources = self.sources.clone();
            let previous = sources.pop()?;
            Some(self.supply_source((!previous.is_empty()).then_some(previous), sources))
        }

        /// The grade researched: the owned one unless another is chosen.
        pub fn grade(&self) -> &str {
            self.grade
                .as_deref()
                .filter(|g| !g.is_empty())
                .unwrap_or("owned")
        }

        /// The sale dates researched: the last year unless others are chosen.
        pub fn window(&self) -> Window {
            let year = Window::last_year();
            let given = |date: &Option<String>| date.clone().filter(|d| !d.is_empty());
            Window {
                from: given(&self.from).unwrap_or(year.from),
                to: given(&self.to).unwrap_or(year.to),
            }
        }

        /// This choice showing another certificate.
        pub fn with_certificate(&self, grader: &str, cert: &str) -> Choice {
            Choice {
                grader: Some(grader.to_owned()),
                cert: Some(cert.to_owned()),
                // A grade explored for one slab may not apply to another (PSA grades only), and
                // its supply sources and comps are its own.
                grade: None,
                source: None,
                rows: None,
                sources: Vec::new(),
                comps: None,
                comps_from: None,
                comp: None,
                extra: Vec::new(),
                ..self.clone()
            }
        }

        /// The next page of the seller's listings, after `next`.
        pub fn next_page(&self, next: &str) -> Choice {
            let mut trail = self.trail.clone();
            trail.push(self.after.clone().unwrap_or_default());
            Choice {
                after: Some(next.to_owned()),
                trail,
                listing: None,
                ..self.clone()
            }
        }

        /// The page before this one, if there is one.
        pub fn previous_page(&self) -> Option<Choice> {
            let mut trail = self.trail.clone();
            let after = trail.pop()?;
            Some(Choice {
                after: (!after.is_empty()).then_some(after),
                trail,
                listing: None,
                ..self.clone()
            })
        }
    }

    impl SlabPricing {
        pub fn at(choice: &Choice) -> SlabPricing {
            SlabPricing {
                choice: choice.clone(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::url::Choice;

    #[test]
    fn paging_keeps_the_trail_back_to_the_first_page() {
        let first = Choice {
            seller: Some("pokebash".into()),
            listing: Some("x".into()),
            ..Choice::default()
        };
        let second = first.next_page("a");
        assert_eq!(second.after.as_deref(), Some("a"));
        assert_eq!(second.trail, [""]);
        assert_eq!(second.listing, None);
        let third = second.next_page("b");
        assert_eq!(third.trail, ["", "a"]);
        let back = third.previous_page().unwrap();
        assert_eq!(back.after.as_deref(), Some("a"));
        let start = back.previous_page().unwrap();
        assert_eq!(start.after, None);
        assert!(start.previous_page().is_none());
    }

    #[test]
    fn previous_source_returns_to_the_default_source() {
        let shown = Choice {
            source: Some("b".into()),
            sources: vec!["".into(), "a".into()],
            rows: Some(50),
            ..Choice::default()
        };
        let back = shown.previous_source().unwrap();
        assert_eq!(back.source.as_deref(), Some("a"));
        assert_eq!(back.rows, None);
        let first = back.previous_source().unwrap();
        assert_eq!(first.source, None);
        assert!(first.previous_source().is_none());
    }

    #[test]
    fn a_certificate_needs_both_halves() {
        let choice = Choice {
            grader: Some("PSA".into()),
            cert: Some(" ".into()),
            ..Choice::default()
        };
        assert_eq!(choice.certificate(), None);
        assert_eq!(
            choice.with_certificate("PSA", "1").certificate(),
            Some(("PSA", "1"))
        );
    }
}
