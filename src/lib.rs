//! TCGPlayer Automation on Corten: every screen, JSON route and worker. The app is this library,
//! so tests and examples reach it; `main.rs` only serves it.
mod api;
mod app;
mod config;
mod csv_text;
mod database;
mod features;
mod glyphs;
mod js_math;
mod js_number;
mod layout;
pub mod migrations;
mod node_pg;
#[cfg(test)]
mod parity_fixture;
mod row_order;
mod tcgplayer;
mod text;
mod theme;
/// The design system's components (`corten ui`): public, so a component not used yet is not a
/// warning.
pub mod ui;

/// The database the app and its migrations use, once `app()` has loaded the environment.
pub fn database_url() -> String {
    config::database_url()
}

/// The app, configured from `.env` and the environment.
pub fn app() -> corten::App {
    config::load_env();
    app::app(app::Shared::from_env())
}
