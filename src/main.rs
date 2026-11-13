//! Serves the app (`src/lib.rs`). Modules are declared there, not here.

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let app = tcgplayer_automation::app();
    // Before the first request, so no request meets a schema behind the code.
    if tcgplayer_automation::migrations::on() {
        let url = tcgplayer_automation::database_url();
        if let Err(why) = tcgplayer_automation::migrations::migrate(&url).await {
            eprintln!("{why}");
            std::process::exit(1);
        }
    }
    corten::serve(app).await
}
