//! TCGPlayer Automation on Corten. Screens move here one at a time from the React Router app in
//! `app/`; every path no ported screen serves is relayed to that app (`legacy`), so one origin
//! serves both while the port runs. The app is this library, so tests and examples reach it;
//! `main.rs` only serves it.
mod app;
mod config;
mod csv_text;
mod database;
mod features;
mod js_math;
mod layout;
mod legacy;
mod tcgplayer;
mod text;
mod theme;
mod zone;

/// The app, configured from `.env` and the environment.
pub fn app() -> corten::App {
    config::load_env();
    app::app(app::Shared::from_env())
}
