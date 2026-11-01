//! Embeds the schema's migrations (`db/migrations/*.sql`) in the binary, in file-name order, so the
//! server applies them without the files beside it (`src/migrations.rs`).
use std::{env, fs, path::Path};

fn main() {
    println!("cargo:rerun-if-changed=db/migrations");
    let mut names: Vec<String> = fs::read_dir("db/migrations")
        .expect("db/migrations is readable")
        .map(|entry| {
            entry
                .expect("a migration")
                .file_name()
                .into_string()
                .expect("a UTF-8 name")
        })
        .filter(|name| name.ends_with(".sql"))
        .collect();
    names.sort();
    let root = env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let entries: String = names
        .iter()
        .map(|name| {
            let path = Path::new(&root).join("db/migrations").join(name);
            format!(
                "    ({name:?}, include_str!({:?})),\n",
                path.display().to_string()
            )
        })
        .collect();
    let out = Path::new(&env::var("OUT_DIR").expect("cargo sets OUT_DIR")).join("migrations.rs");
    fs::write(out, format!("&[\n{entries}]\n")).expect("OUT_DIR is writable");
}
