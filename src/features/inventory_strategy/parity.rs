//! The Rust strategy against the Node app's, on the dev seller. Run
//! `npx vite-node scripts/strategy-snapshot.ts` with the Node app's environment, then
//! `NODE_STRATEGY=target/node-strategy.json cargo test strategy_matches_node -- --ignored`.
use chrono::{DateTime, Utc};
use serde_json::Value;

use super::{performance, sold_units};
use crate::database::Database;

/// Two JSON values equal but for floating point noise in numbers.
fn same(path: &str, ours: &Value, theirs: &Value) {
    match (ours, theirs) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            assert!(
                (a - b).abs() <= 1e-9 * a.abs().max(1.0),
                "{path}: {a} != {b}"
            );
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: lengths");
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                same(&format!("{path}[{i}]"), x, y);
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
            keys.sort();
            keys.dedup();
            for k in keys {
                same(
                    &format!("{path}.{k}"),
                    a.get(k).unwrap_or(&Value::Null),
                    b.get(k).unwrap_or(&Value::Null),
                );
            }
        }
        (Value::String(a), Value::String(b)) if a.ends_with('Z') && b.ends_with('Z') => {
            let (x, y): (DateTime<Utc>, DateTime<Utc>) = (a.parse().unwrap(), b.parse().unwrap());
            assert_eq!(x, y, "{path}");
        }
        _ => assert_eq!(ours, theirs, "{path}"),
    }
}

#[tokio::test]
#[ignore = "reads the dev database and a file the Node app wrote"]
async fn strategy_matches_node() {
    crate::config::load_env();
    let path = std::env::var("NODE_STRATEGY").expect("NODE_STRATEGY names Node's answer");
    let node: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let seller = node["seller"].as_str().unwrap();
    let now: DateTime<Utc> = node["now"].as_str().unwrap().parse().unwrap();
    let db = Database::connect_lazy(&crate::config::database_url());
    let lines = sold_units::load(&db, seller).await.unwrap();
    assert!(!lines.is_empty(), "the dev seller has sold units");
    let report = performance::summarize_realized(&lines, now, &performance::PERFORMANCE_WINDOWS);
    same(
        "report",
        &serde_json::to_value(&report).unwrap(),
        &node["report"],
    );
    let weeks = performance::summarize_trend(&lines, now, performance::MARGIN_TREND_WEEKS);
    same(
        "weeks",
        &serde_json::to_value(&weeks).unwrap(),
        &node["marginTrend"]["weeks"],
    );
}
