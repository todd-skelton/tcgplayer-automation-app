//! TCGPlayer Automation on Corten. Screens move here one at a time from the React Router app in
//! `app/`; every path no ported screen serves is relayed to that app (`legacy`), so one origin
//! serves both while the port runs.
mod app;
mod config;
mod csv_text;
mod database;
mod features;
mod layout;
mod legacy;
mod tcgplayer;
mod text;
mod theme;
mod zone;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    config::load_env();
    let shared = app::Shared::from_env();
    corten::serve(app::app(shared)).await
}
