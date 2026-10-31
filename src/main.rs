//! Serves the app (`src/lib.rs`). Modules are declared there, not here.

#[tokio::main]
async fn main() -> std::io::Result<()> {
    corten::serve(tcgplayer_automation::app()).await
}
