//! The catalog jobs: TCGplayer's product lines, sets, products and SKUs read into the local
//! tables (`catalog-sync` and `home.server.ts` in the Node app).
pub mod maintenance;
pub mod refresh;
pub mod source;
pub mod store;
pub mod sync;

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::{Value, json};
    use sqlx::Connection;

    use super::{
        maintenance::{self, Request},
        source::Catalog,
    };
    use crate::features::http_configuration::config::Domain;

    /// TCGplayer's catalog as `.port-logs/catalog-cases.json` scripts it, noting every request, as
    /// `catalog-node.ts` scripts it for Node.
    struct Scripted {
        cases: Value,
        asked: Mutex<Vec<Value>>,
    }

    impl Catalog for Scripted {
        async fn get(&self, domain: Domain, path: &str) -> Result<Value, String> {
            let domain = match domain {
                Domain::MpApi => "MpApi",
                Domain::MpSearchApi => "MpSearchApi",
                other => panic!("{other:?} is not read"),
            };
            self.asked
                .lock()
                .unwrap()
                .push(json!({ "domain": domain, "path": path }));
            match &self.cases["get"][path] {
                Value::Null => Err(format!("unscripted {path}")),
                Value::String(s) if s == "fail" => Err("scripted failure".to_owned()),
                answer => Ok(answer.clone()),
            }
        }

        async fn search(&self, body: &Value) -> Result<Value, String> {
            self.asked.lock().unwrap().push(json!({ "search": body }));
            let line = body["filters"]["term"]["productLineName"][0]
                .as_str()
                .unwrap();
            if body["size"] == 0 {
                let c = &self.cases["counts"][line];
                return Ok(
                    json!({ "results": [{ "totalResults": c["total"], "results": [],
                    "aggregations": { "setName": c["sets"] } }] }),
                );
            }
            let set = body["filters"]["term"]["setName"][0].as_str().unwrap();
            match &self.cases["search"][format!("{line}|{set}")] {
                Value::Null => Err(format!("unscripted search {line}")),
                Value::String(s) if s == "fail" => Err("scripted failure".to_owned()),
                s => {
                    let products = s["products"].as_array().unwrap();
                    let from = body["from"].as_u64().unwrap() as usize;
                    let size = body["size"].as_u64().unwrap() as usize;
                    let page: Vec<&Value> = products.iter().skip(from).take(size).collect();
                    Ok(json!({ "results": [{ "totalResults": products.len(), "results": page }] }))
                }
            }
        }
    }

    /// A job as the React form's fields name it.
    fn request(fields: &Value) -> Request {
        let text = |key: &str| fields[key].as_str().unwrap_or("").to_owned();
        let number = |key: &str| text(key).parse().unwrap_or(0);
        match fields["actionType"].as_str().unwrap() {
            "fetchAllProductLines" => Request::ProductLines,
            "fetchAllCategory3Data" => Request::EveryProduct {
                line: number("categoryId"),
            },
            "syncNewProducts" => Request::NewProducts {
                line: number("categoryId"),
            },
            "updateProductAndSkus" => Request::Product {
                line: number("productLineId"),
                product: number("productId"),
            },
            "fetchSetProductsAndSkus" => Request::Set {
                set: text("setName"),
                line: text("productLineName"),
                delete_existing: text("deleteExistingSet") == "on",
            },
            other => panic!("{other}"),
        }
    }

    /// Requests in a stable order: Node reads products' details five at a time and the product
    /// lines' filters all at once, so their order is not its order.
    fn sorted(asked: &[Value]) -> Vec<String> {
        let mut asked: Vec<String> = asked.iter().map(Value::to_string).collect();
        asked.sort();
        asked
    }

    /// Each job in `.port-logs/catalog-cases.json`, in order from what `catalog-seed.sql` stores, on
    /// the dev database in a transaction rolled back, against Node's `runCatalogMaintenance` over the
    /// same (`.port-logs/catalog-node.ts`): each answer and status, the requests made, and every catalog
    /// row left in the port's id ranges.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's run in .port-logs"]
    async fn jobs_run_as_node_runs_them() {
        crate::config::load_env();
        let read = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let node: Value = serde_json::from_str(&read("catalog.node.json")).unwrap();
        let cases: Value = serde_json::from_str(&read("catalog-cases.json")).unwrap();
        let catalog = Scripted {
            cases: cases.clone(),
            asked: Mutex::default(),
        };
        let mut conn = sqlx::PgConnection::connect(&crate::config::database_url())
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        sqlx::raw_sql(&read("catalog-seed.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        let mut failures = Vec::new();
        for (job, theirs) in cases["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .zip(node["answers"].as_array().unwrap())
        {
            catalog.asked.lock().unwrap().clear();
            let answer = maintenance::run(&mut tx, &catalog, &request(&job["fields"])).await;
            let body = match answer.outcome {
                Ok(message) => json!({ "message": message }),
                Err(error) => json!({ "error": error }),
            };
            let name = &job["name"];
            if json!(answer.status) != theirs["status"] || body != theirs["body"] {
                failures.push(format!(
                    "{name}: {} {body}
Node: {} {}",
                    answer.status, theirs["status"], theirs["body"]
                ));
            }
            let ours = sorted(&catalog.asked.lock().unwrap());
            if ours != sorted(theirs["asked"].as_array().unwrap()) {
                failures.push(format!(
                    "{name}: asked {ours:#?}
Node: {:#?}",
                    sorted(theirs["asked"].as_array().unwrap())
                ));
            }
        }
        let captured: String = sqlx::query_scalar(&read("catalog-capture.sql"))
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        tx.rollback().await.unwrap();
        let captured: Value = serde_json::from_str(&captured).unwrap();
        for (key, theirs) in node["captured"].as_object().unwrap() {
            if &captured[key] != theirs {
                failures.push(format!(
                    "{key}: {:#}
Node: {theirs:#}",
                    captured[key]
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "{}",
            failures.join(
                "

"
            )
        );
    }
}
