//! Recordings the parity tests compare with (`tests/fixtures`).
use std::path::PathBuf;

use serde::de::DeserializeOwned;

/// `tests/fixtures/<name>`, read as JSON.
pub fn read<T: DeserializeOwned>(name: &str) -> T {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}
