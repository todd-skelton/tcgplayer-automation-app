//! Configuration: how prices are chosen (the policy, percentiles, the price floor), product lines
//! priced differently, shipping threshold snaps and supply analysis, which every pricing run reads.
//! Ported from `app/features/pricing/routes/configuration.tsx`.
//!
//! Each section saves itself when a control in it changes, as the React screen did, and answers
//! with itself. A browser without scripts gets a Save button per section.
//!
//! | Route | Answer |
//! |---|---|
//! | `GET /configuration` | every section; `?done=reset` after a reset |
//! | `POST /configuration/pricing` | the pricing section saved |
//! | `POST /configuration/product-lines/default` | the default percentile saved |
//! | `POST /configuration/product-lines` | a product line's setting added |
//! | `POST /configuration/product-lines/{id}/remove` | a product line's setting removed |
//! | `POST /configuration/snaps` | the shipping threshold snaps saved |
//! | `POST /configuration/supply` | supply analysis saved |
//! | `POST /configuration/reset` | every setting back to its default |
//! | `GET /configuration/calibration?days=` | the calibration report panel over that window |
//! | `GET /configuration/calibration/live` | the calibration panel once read, for `<corten-live>` |
//! | `GET /configuration/shipping-report?days=` | the shipping report panel over that window |
//! | `GET /configuration/shipping-report/live` | the shipping panel once read, for `<corten-live>` |
//!
//! The two reports are still computed by the Node app ([`reports`]); the page draws them waiting
//! and a `<corten-live>` stream sends each once read, so the settings never wait for them.
//!
//! Not ported: the React screen's File Configuration and Form Defaults, which lived in the
//! browser's localStorage (`tcgplayer-file-config`, `tcgplayer-form-defaults`). Only screens
//! still in React read them, and the batch form still saves its seller key there; they are
//! decided with the inventory intake and batch pricer ports.
mod config;
mod form;
mod page;
mod reports;
mod views;

pub use views::COMPONENTS;

// Handlers are named from here, where the routes module is declared.
use page::{
    add_line, calibration_live, calibration_report, remove_line, reset, save_default, save_pricing,
    save_snaps, save_supply, shipping_live, shipping_report, show,
};

#[corten::routes(area = Configuration, state = crate::app::Shared)]
pub mod url {
    #[route("/configuration", get = show)]
    pub struct Configuration {
        pub done: Option<super::page::Done>,
    }

    #[route("/configuration/pricing", post = save_pricing)]
    pub struct SavePricing;

    #[route("/configuration/product-lines/default", post = save_default)]
    pub struct SaveDefaultPercentile;

    #[route("/configuration/product-lines", post = add_line)]
    pub struct AddProductLine;

    #[route("/configuration/product-lines/{id}/remove", post = remove_line)]
    pub struct RemoveProductLine {
        pub id: i32,
    }

    #[route("/configuration/snaps", post = save_snaps)]
    pub struct SaveSnaps;

    #[route("/configuration/supply", post = save_supply)]
    pub struct SaveSupply;

    #[route("/configuration/reset", post = reset)]
    pub struct ResetConfiguration;

    #[route("/configuration/calibration", get = calibration_report)]
    pub struct CalibrationReport {
        #[route(query)]
        pub window: super::reports::Window,
    }

    #[route("/configuration/calibration/live", get = calibration_live)]
    pub struct CalibrationLive;

    #[route("/configuration/shipping-report", get = shipping_report)]
    pub struct ShippingReport {
        #[route(query)]
        pub window: super::reports::Window,
    }

    #[route("/configuration/shipping-report/live", get = shipping_live)]
    pub struct ShippingReportLive;
}
