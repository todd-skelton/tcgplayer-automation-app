//! Continuous Pricing: the schedule that refreshes the seller's live inventory from TCGplayer,
//! claims the SKUs due for pricing and queues price-only batches; the tracked inventory, a page
//! at a time; and the recent automatic runs. Ported from
//! `app/features/continuous-pricing/routes/continuous-pricing.tsx`.
//!
//! The schedule, the inventory and pausing or enabling a SKU are read and written here, with the
//! Node app's queries. Refreshing the inventory, a scheduler cycle and repricing stay the Node
//! app's (`/api/continuous-pricing`), which call TCGplayer and queue work for the pricing worker.
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /continuous-pricing` | the schedule, the inventory's status, a page of it, and the recent runs; `?done=` says what the last post did |
//! | `POST /continuous-pricing/schedule` | the schedule saved, or the form with what is wrong |
//! | `POST /continuous-pricing/refresh` | the seller's inventory read again from TCGplayer |
//! | `POST /continuous-pricing/run` | a scheduler cycle run now |
//! | `POST /continuous-pricing/apply-policy` | the inventory repriced from saved curves where it can be |
//! | `POST /continuous-pricing/mark-due` | every eligible SKU made due, then a scheduler cycle |
//! | `POST /continuous-pricing/sku` | one SKU enabled or paused |
//!
//! A post the Node app refuses answers 409 with the page and why.
mod actions;
pub mod store;
mod views;

pub use views::COMPONENTS;

// Handlers are named from here, where the routes module is declared.
use actions::{apply_policy, mark_due, refresh, run, save, set_sku, show};

#[corten::routes(area = ContinuousPricing, state = crate::app::Shared)]
pub mod url {
    use super::store::Shown;

    #[route("/continuous-pricing", get = show)]
    pub struct ContinuousPricing {
        #[route(query)]
        pub view: View,
    }

    #[route("/continuous-pricing/schedule", post = save)]
    pub struct SaveSchedule {
        #[route(query)]
        pub view: View,
    }

    #[route("/continuous-pricing/refresh", post = refresh)]
    pub struct Refresh {
        #[route(query)]
        pub view: View,
    }

    #[route("/continuous-pricing/run", post = run)]
    pub struct Run {
        #[route(query)]
        pub view: View,
    }

    #[route("/continuous-pricing/apply-policy", post = apply_policy)]
    pub struct ApplyPolicy {
        #[route(query)]
        pub view: View,
    }

    #[route("/continuous-pricing/mark-due", post = mark_due)]
    pub struct MarkDue {
        #[route(query)]
        pub view: View,
    }

    #[route("/continuous-pricing/sku", post = set_sku)]
    pub struct SetSku {
        #[route(query)]
        pub view: View,
    }

    /// The page of inventory shown (`q` searched, `state` chosen), and what the last post did.
    /// What it did is carried in the address because a redirect cannot say it (corten#385).
    #[derive(Clone, Debug, Default, serde::Deserialize, corten::Route, corten::Fields)]
    #[route(query)]
    pub struct View {
        pub q: Option<String>,
        pub state: Option<Shown>,
        pub page: Option<i64>,
        pub done: Option<super::views::Done>,
        /// What a scheduler cycle came to, when one ran.
        pub cycle: Option<super::views::Cycle>,
        /// The numbers the message names: SKUs, a batch, its SKUs, batches, SKUs left due.
        pub count: Option<i64>,
        pub batch: Option<i32>,
        pub items: Option<i64>,
        pub batches: Option<i64>,
        pub remaining: Option<i64>,
        pub sku: Option<i32>,
    }

    impl View {
        /// The same page of inventory, saying nothing.
        pub fn quiet(&self) -> View {
            View {
                q: self.q.clone(),
                state: self.state,
                page: self.page,
                ..View::default()
            }
        }

        pub fn search(&self) -> &str {
            self.q.as_deref().unwrap_or("").trim()
        }

        pub fn shown(&self) -> Shown {
            self.state.unwrap_or_default()
        }

        /// The same search on page `page`.
        pub fn at_page(&self, page: i64) -> View {
            View {
                page: (page > 1).then_some(page),
                ..self.quiet()
            }
        }
    }
}
