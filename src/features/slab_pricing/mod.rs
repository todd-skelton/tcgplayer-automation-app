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
//! The recommendation, comp review, supply, maintenance, outcomes and publication panels are
//! still being ported.
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
//!
//! A post the Node app refuses answers 409 with the page and why.
mod actions;
mod identity;
mod inventory;
mod page;
mod research;
mod views;

pub use views::COMPONENTS;

// Handlers are named from here, where the routes module is declared.
use actions::{assign, cancel, confirm, import, look_up, open, refresh};
use page::{evidence, show};

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
    }

    impl Choice {
        /// The certificate shown, when both halves are given.
        pub fn certificate(&self) -> Option<(&str, &str)> {
            self.grader
                .as_deref()
                .zip(self.cert.as_deref())
                .filter(|(g, c)| !g.trim().is_empty() && !c.trim().is_empty())
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
                // A grade explored for one slab may not apply to another (PSA grades only).
                grade: None,
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
