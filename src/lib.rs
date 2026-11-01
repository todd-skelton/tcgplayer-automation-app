//! TCGPlayer Automation on Corten. Every screen is drawn here; the React screens in `app/` are
//! gone. The Node app there still answers its JSON routes (`/api/...`) and runs its workers until
//! cutover, and every path this app does not serve is relayed to it (`legacy`), so one origin
//! serves both. The app is this library, so tests and examples reach it;
//! `main.rs` only serves it.
mod app;
mod config;
mod csv_text;
mod database;
mod features;
mod js_math;
mod js_number;
mod layout;
mod legacy;
pub mod migrations;
mod tcgplayer;
mod text;
mod theme;

/// The database the app and its migrations use, once `app()` has loaded the environment.
pub fn database_url() -> String {
    config::database_url()
}

/// The app, configured from `.env` and the environment.
pub fn app() -> corten::App {
    config::load_env();
    app::app(app::Shared::from_env())
}
