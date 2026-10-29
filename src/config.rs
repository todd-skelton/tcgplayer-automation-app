//! Settings from the environment, loaded from the same `.env` files the Node app reads
//! (`scripts/load-local-env.mjs`), so both apps see one configuration. A value already in the
//! environment wins over the files.

/// The mode, from `NODE_ENV` as the Node app reads it: `development` unless it says `production`.
fn mode() -> &'static str {
    match std::env::var("NODE_ENV").as_deref() {
        Ok("production") => "production",
        _ => "development",
    }
}

/// Whether this is the production deployment, as `NODE_ENV` says.
pub fn production() -> bool {
    mode() == "production"
}

/// Whether the environment sets `name` to something other than blanks.
pub fn is_set(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| !value.trim().is_empty())
}

fn env_files(mode: &str) -> &'static [&'static str] {
    match mode {
        "production" => &[".env.production.local", ".env.production", ".env"],
        _ => &[
            ".env.development.local",
            ".env.local",
            ".env.development",
            ".env",
        ],
    }
}

/// Loads the mode's files in order; the first file to set a name wins, and none overrides the
/// environment.
pub fn load_env() {
    for file in env_files(mode()) {
        let _ = dotenvy::from_filename(file);
    }
}

/// The database the Node app uses: `DATABASE_URL`, or the standalone dev database.
pub fn database_url() -> String {
    std::env::var("DATABASE_URL").unwrap_or_else(|_| {
        "postgresql://postgres:postgres@localhost:5433/tcgplayer_automation".into()
    })
}

/// Where the React Router app listens: `LEGACY_ORIGIN`, or its dev server.
pub fn legacy_origin() -> String {
    std::env::var("LEGACY_ORIGIN").unwrap_or_else(|_| "http://localhost:5173".into())
}
