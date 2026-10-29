//! Uploaded pull sheets (`pull_sheets`, migration 053).
use chrono::{DateTime, Utc};

use crate::database::Database;

#[derive(sqlx::FromRow)]
pub struct StoredSheet {
    pub pull_sheet_id: i64,
    pub file_name: String,
    pub csv_text: String,
}

#[derive(sqlx::FromRow)]
pub struct RecentSheet {
    pub pull_sheet_id: i64,
    pub file_name: String,
    pub uploaded_at: DateTime<Utc>,
}

pub async fn save(db: &Database, file_name: &str, csv_text: &str) -> sqlx::Result<i64> {
    sqlx::query_scalar(
        "INSERT INTO pull_sheets (file_name, csv_text) VALUES ($1, $2) RETURNING pull_sheet_id",
    )
    .bind(file_name)
    .bind(csv_text)
    .fetch_one(&db.0)
    .await
}

pub async fn find(db: &Database, id: i64) -> sqlx::Result<Option<StoredSheet>> {
    sqlx::query_as(
        "SELECT pull_sheet_id, file_name, csv_text FROM pull_sheets WHERE pull_sheet_id = $1",
    )
    .bind(id)
    .fetch_optional(&db.0)
    .await
}

pub async fn recent(db: &Database) -> sqlx::Result<Vec<RecentSheet>> {
    sqlx::query_as("SELECT pull_sheet_id, file_name, uploaded_at FROM pull_sheets ORDER BY uploaded_at DESC LIMIT 10")
        .fetch_all(&db.0)
        .await
}
