use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(
        code: impl Into<String>,
        message: impl Into<String>,
        details: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: Some(details.into()),
        }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        AppError::with_details("DB_ERROR", "Database operation failed", err.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::with_details("IO_ERROR", "Filesystem operation failed", err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::with_details("SERIALIZATION_ERROR", "JSON parsing failed", err.to_string())
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RootFolder {
    pub id: string_id::StringId,
    pub path: String,
    pub name: String,
    pub missing: bool,
    pub media_count: i64,
}

pub mod string_id {
    pub type StringId = String;
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: String,
    pub root_id: String,
    pub path: String,
    pub kind: String,
    pub name: String,
    pub size_bytes: i64,
    pub modified_ms: i64,
    pub content_hash: Option<String>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub duration_ms: Option<i64>,
    pub favorite: bool,
    pub missing: bool,
    pub tags: Vec<String>,
    pub thumbnail_url: Option<String>,
    pub asset_url: Option<String>,
    pub proxy_url: Option<String>,
    pub has_proxy: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryQuery {
    pub root_id: Option<String>,
    pub search: Option<String>,
    pub kind: Option<String>,
    pub favorite_only: Option<bool>,
    pub tag: Option<String>,
    pub page: Option<i64>,
    pub page_size: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPageResult {
    pub items: Vec<MediaItem>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BoardSummary {
    pub id: String,
    pub name: String,
    pub item_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EditorSummary {
    pub id: String,
    pub name: String,
    pub width: i32,
    pub height: i32,
    pub layer_count: i64,
}

pub struct Database {
    conn: Mutex<Connection>,
    db_path: PathBuf,
}

impl Database {
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn new(db_path: &Path) -> Result<Arc<Self>, AppError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;
        conn.execute("PRAGMA foreign_keys = ON;", [])?;
        conn.pragma_update(None, "journal_mode", "WAL")?;

        let mut db = Self {
            conn: Mutex::new(conn),
            db_path: db_path.to_path_buf(),
        };
        db.migrate()?;
        Ok(Arc::new(db))
    }

    fn migrate(&mut self) -> Result<(), AppError> {
        let conn = self.conn.get_mut();
        let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 1 {
            let tx = conn.transaction()?;
            tx.execute_batch(
                r#"
                PRAGMA foreign_keys = ON;

                CREATE TABLE IF NOT EXISTS roots (
                    id TEXT PRIMARY KEY,
                    path TEXT NOT NULL UNIQUE
                );

                CREATE TABLE IF NOT EXISTS media (
                    id TEXT PRIMARY KEY,
                    root_id TEXT NOT NULL,
                    path TEXT NOT NULL UNIQUE,
                    kind TEXT NOT NULL,
                    name TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    modified_ms INTEGER NOT NULL,
                    content_hash TEXT,
                    width INTEGER,
                    height INTEGER,
                    duration_ms INTEGER,
                    favorite INTEGER NOT NULL DEFAULT 0,
                    missing INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY(root_id) REFERENCES roots(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_media_root ON media(root_id);
                CREATE INDEX IF NOT EXISTS idx_media_kind ON media(kind);
                CREATE INDEX IF NOT EXISTS idx_media_favorite ON media(favorite);
                CREATE INDEX IF NOT EXISTS idx_media_missing ON media(missing);
                CREATE INDEX IF NOT EXISTS idx_media_path ON media(path);

                CREATE TABLE IF NOT EXISTS tags (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE COLLATE NOCASE
                );

                CREATE TABLE IF NOT EXISTS media_tags (
                    media_id TEXT NOT NULL,
                    tag_id TEXT NOT NULL,
                    PRIMARY KEY (media_id, tag_id),
                    FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE,
                    FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS reviews (
                    media_id TEXT PRIMARY KEY,
                    document_json TEXT NOT NULL,
                    FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS boards (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    document_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS editors (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    document_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                PRAGMA user_version = 1;
                "#,
            )?;
            tx.commit()?;
        }
        if version < 2 {
            let tx = conn.transaction()?;
            let has_hash_col: bool = tx
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('media') WHERE name = 'content_hash'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);
            if !has_hash_col {
                tx.execute("ALTER TABLE media ADD COLUMN content_hash TEXT;", [])?;
            }
            tx.execute("PRAGMA user_version = 2;", [])?;
            tx.commit()?;
        }
        Ok(())
    }

    // Roots
    pub fn add_root(&self, path: &str) -> Result<RootFolder, AppError> {
        let conn = self.conn.lock();
        let normalized = Path::new(path)
            .canonicalize()
            .map_err(|e| AppError::with_details("INVALID_PATH", "Could not canonicalize path", e.to_string()))?
            .to_string_lossy()
            .to_string();

        let clean_path = if normalized.starts_with(r"\\?\") {
            normalized[4..].to_string()
        } else {
            normalized
        };

        let existing: Option<(String, String)> = conn
            .query_row(
                "SELECT id, path FROM roots WHERE path = ?1",
                params![clean_path],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        let (id, stored_path) = match existing {
            Some(ex) => ex,
            None => {
                let id = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO roots (id, path) VALUES (?1, ?2)",
                    params![id, clean_path],
                )?;
                (id, clean_path)
            }
        };

        let name = Path::new(&stored_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| stored_path.clone());

        let missing = !Path::new(&stored_path).exists();
        let media_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM media WHERE root_id = ?1",
            params![id],
            |r| r.get(0),
        )?;

        Ok(RootFolder {
            id,
            path: stored_path,
            name,
            missing,
            media_count,
        })
    }

    pub fn list_roots(&self) -> Result<Vec<RootFolder>, AppError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT r.id, r.path, COUNT(m.id) FROM roots r LEFT JOIN media m ON r.id = m.root_id WHERE r.id != 'unlinked' AND r.path != '__unlinked__' GROUP BY r.id, r.path ORDER BY r.path ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            let id: String = r.get(0)?;
            let path: String = r.get(1)?;
            let media_count: i64 = r.get(2)?;
            let name = Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            let missing = !Path::new(&path).exists();
            Ok(RootFolder {
                id,
                path,
                name,
                missing,
                media_count,
            })
        })?;

        let mut roots = Vec::new();
        for r in rows {
            roots.push(r?);
        }
        Ok(roots)
    }

    pub fn remove_root(&self, root_id: &str) -> Result<(), AppError> {
        let conn = self.conn.lock();
        // Marking media as missing instead of deleting media records if referenced
        // The plan specifies: "removing a library root never deletes originals and retains referenced media records as missing."
        let mut stmt = conn.prepare("SELECT id FROM media WHERE root_id = ?1")?;
        let media_ids: Vec<String> = stmt
            .query_map(params![root_id], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        // Check which media items are referenced in reviews, boards, or have tags
        for m_id in &media_ids {
            conn.execute(
                "UPDATE media SET missing = 1 WHERE id = ?1",
                params![m_id],
            )?;
        }

        // Delete the root from roots table (disabling cascade for this operation or unlinking root_id)
        // To preserve media records while removing root, we can create a special unlinked root or set root_id
        // Actually, since foreign key is ON DELETE CASCADE, let's update media items to keep them or remove unreferenced ones.
        // Let's create an 'orphan' or 'unlinked' root if necessary, or update root_id
        let orphan_root_id = "unlinked";
        conn.execute(
            "INSERT OR IGNORE INTO roots (id, path) VALUES (?1, '__unlinked__')",
            params![orphan_root_id],
        )?;
        conn.execute(
            "UPDATE media SET root_id = ?1, missing = 1 WHERE root_id = ?2",
            params![orphan_root_id, root_id],
        )?;
        conn.execute("DELETE FROM roots WHERE id = ?1", params![root_id])?;

        Ok(())
    }

    pub fn get_root(&self, root_id: &str) -> Result<Option<RootFolder>, AppError> {
        if root_id == "unlinked" {
            return Ok(None);
        }
        let conn = self.conn.lock();
        let res = conn
            .query_row(
                "SELECT r.id, r.path, COUNT(m.id) FROM roots r LEFT JOIN media m ON r.id = m.root_id WHERE r.id = ?1 AND r.id != 'unlinked' GROUP BY r.id, r.path",
                params![root_id],
                |r| {
                    let id: String = r.get(0)?;
                    let path: String = r.get(1)?;
                    let media_count: i64 = r.get(2)?;
                    let name = Path::new(&path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| path.clone());
                    let missing = !Path::new(&path).exists();
                    Ok(RootFolder {
                        id,
                        path,
                        name,
                        missing,
                        media_count,
                    })
                },
            )
            .optional()?;
        Ok(res)
    }

    // Media Catalog Operations
    pub fn upsert_media(
        &self,
        root_id: &str,
        path: &str,
        kind: &str,
        name: &str,
        size_bytes: i64,
        modified_ms: i64,
        content_hash: Option<&str>,
    ) -> Result<MediaItem, AppError> {
        let conn = self.conn.lock();
        let existing: Option<(String, i64, i64, Option<String>, Option<i32>, Option<i32>, Option<i64>, bool, bool)> = conn
            .query_row(
                "SELECT id, size_bytes, modified_ms, content_hash, width, height, duration_ms, favorite, missing FROM media WHERE path = ?1",
                params![path],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)),
            )
            .optional()?;

        let item = match existing {
            Some((id, old_size, old_mod, old_hash, width, height, duration, _favorite, _missing)) => {
                let hash_changed = old_hash.as_deref() != content_hash;
                let size_changed = old_size != size_bytes || old_mod != modified_ms || hash_changed;
                let (w, h, d) = if size_changed {
                    (None, None, None)
                } else {
                    (width, height, duration)
                };

                conn.execute(
                    "UPDATE media SET root_id = ?1, name = ?2, size_bytes = ?3, modified_ms = ?4, content_hash = ?5, width = ?6, height = ?7, duration_ms = ?8, missing = 0 WHERE id = ?9",
                    params![root_id, name, size_bytes, modified_ms, content_hash, w, h, d, id],
                )?;

                self.load_media_item_internal(&conn, &id)?
            }
            None => {
                let id = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO media (id, root_id, path, kind, name, size_bytes, modified_ms, content_hash, favorite, missing) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 0)",
                    params![id, root_id, path, kind, name, size_bytes, modified_ms, content_hash],
                )?;
                self.load_media_item_internal(&conn, &id)?
            }
        };

        Ok(item)
    }

    pub fn update_media_metadata(
        &self,
        media_id: &str,
        width: Option<i32>,
        height: Option<i32>,
        duration_ms: Option<i64>,
    ) -> Result<(), AppError> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE media SET width = ?1, height = ?2, duration_ms = ?3 WHERE id = ?4",
            params![width, height, duration_ms, media_id],
        )?;
        Ok(())
    }

    pub fn mark_media_missing_in_root(&self, root_id: &str, existing_paths: &[String]) -> Result<usize, AppError> {
        let conn = self.conn.lock();
        let mut count = 0;
        let mut stmt = conn.prepare("SELECT id, path FROM media WHERE root_id = ?1 AND missing = 0")?;
        let rows: Vec<(String, String)> = stmt
            .query_map(params![root_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        let path_set: std::collections::HashSet<&str> = existing_paths.iter().map(|s| s.as_str()).collect();
        for (id, path) in rows {
            if !path_set.contains(path.as_str()) {
                conn.execute("UPDATE media SET missing = 1 WHERE id = ?1", params![id])?;
                count += 1;
            }
        }
        Ok(count)
    }

    pub fn set_favorite(&self, media_id: &str, favorite: bool) -> Result<(), AppError> {
        let conn = self.conn.lock();
        let fav_int = if favorite { 1 } else { 0 };
        let affected = conn.execute("UPDATE media SET favorite = ?1 WHERE id = ?2", params![fav_int, media_id])?;
        if affected == 0 {
            return Err(AppError::new("NOT_FOUND", format!("Media not found: {}", media_id)));
        }
        Ok(())
    }

    pub fn relink_media(&self, media_id: &str, new_path: &str, content_hash: Option<&str>) -> Result<MediaItem, AppError> {
        let conn = self.conn.lock();
        let path = Path::new(new_path);
        if !path.exists() {
            return Err(AppError::new("FILE_NOT_FOUND", "Relink destination does not exist"));
        }
        let metadata = std::fs::metadata(path)?;
        let size_bytes = metadata.len() as i64;
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| new_path.to_string());

        let clean_path = path.canonicalize()?.to_string_lossy().to_string();
        let stored_path = if clean_path.starts_with(r"\\?\") {
            clean_path[4..].to_string()
        } else {
            clean_path
        };

        // Check if stored_path is already used by another media ID
        let conflict: Option<String> = conn
            .query_row(
                "SELECT id FROM media WHERE path = ?1 AND id != ?2",
                params![stored_path, media_id],
                |r| r.get(0),
            )
            .optional()?;
        if conflict.is_some() {
            return Err(AppError::new("PATH_CONFLICT", "Another media entry already points to this file"));
        }

        conn.execute(
            "UPDATE media SET path = ?1, name = ?2, size_bytes = ?3, modified_ms = ?4, content_hash = ?5, missing = 0, width = NULL, height = NULL, duration_ms = NULL WHERE id = ?6",
            params![stored_path, name, size_bytes, modified_ms, content_hash, media_id],
        )?;

        self.load_media_item_internal(&conn, media_id)
    }

    pub fn get_media(&self, id: &str) -> Result<MediaItem, AppError> {
        let conn = self.conn.lock();
        self.load_media_item_internal(&conn, id)
    }

    pub fn get_media_by_path(&self, path: &str) -> Result<Option<MediaItem>, AppError> {
        let conn = self.conn.lock();
        let id: Option<String> = conn
            .query_row("SELECT id FROM media WHERE path = ?1", params![path], |r| r.get(0))
            .optional()?;
        match id {
            Some(i) => Ok(Some(self.load_media_item_internal(&conn, &i)?)),
            None => Ok(None),
        }
    }

    fn load_media_item_internal(&self, conn: &Connection, id: &str) -> Result<MediaItem, AppError> {
        let row = conn.query_row(
            "SELECT id, root_id, path, kind, name, size_bytes, modified_ms, content_hash, width, height, duration_ms, favorite, missing FROM media WHERE id = ?1",
            params![id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, Option<i32>>(8)?,
                    r.get::<_, Option<i32>>(9)?,
                    r.get::<_, Option<i64>>(10)?,
                    r.get::<_, i64>(11)? != 0,
                    r.get::<_, i64>(12)? != 0,
                ))
            },
        ).optional()?;

        let (id, root_id, path, kind, name, size_bytes, modified_ms, content_hash, width, height, duration_ms, favorite, missing) =
            row.ok_or_else(|| AppError::new("NOT_FOUND", format!("Media not found: {}", id)))?;

        // Get tags
        let mut tag_stmt = conn.prepare(
            "SELECT t.name FROM tags t JOIN media_tags mt ON t.id = mt.tag_id WHERE mt.media_id = ?1 ORDER BY t.name ASC",
        )?;
        let tags: Vec<String> = tag_stmt
            .query_map(params![id], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;

        // Check if physical file exists to dynamically update missing flag if needed
        let actually_missing = missing || !Path::new(&path).exists();

        Ok(MediaItem {
            id: id.clone(),
            root_id,
            path,
            kind,
            name,
            size_bytes,
            modified_ms,
            content_hash,
            width,
            height,
            duration_ms,
            favorite,
            missing: actually_missing,
            tags,
            thumbnail_url: None,
            asset_url: None,
            proxy_url: None,
            has_proxy: false,
        })
    }

    pub fn query_media(&self, q: &LibraryQuery) -> Result<LibraryPageResult, AppError> {
        let conn = self.conn.lock();
        let page = q.page.unwrap_or(0).max(0);
        let page_size = q.page_size.unwrap_or(100).max(1);

        let mut conditions = Vec::new();
        let mut params_vec: Vec<rusqlite::types::Value> = Vec::new();

        if let Some(rid) = &q.root_id {
            if !rid.is_empty() {
                conditions.push("m.root_id = ?".to_string());
                params_vec.push(rid.clone().into());
            }
        }

        if let Some(kind) = &q.kind {
            if kind != "all" && !kind.is_empty() {
                conditions.push("m.kind = ?".to_string());
                params_vec.push(kind.clone().into());
            }
        }

        if let Some(fav) = q.favorite_only {
            if fav {
                conditions.push("m.favorite = 1".to_string());
            }
        }

        if let Some(search) = &q.search {
            let term = search.trim();
            if !term.is_empty() {
                conditions.push("(m.name LIKE ? OR EXISTS (SELECT 1 FROM media_tags mt JOIN tags t ON mt.tag_id = t.id WHERE mt.media_id = m.id AND t.name LIKE ?))".to_string());
                let like_pattern = format!("%{}%", term);
                params_vec.push(like_pattern.clone().into());
                params_vec.push(like_pattern.into());
            }
        }

        if let Some(tag) = &q.tag {
            let t = tag.trim();
            if !t.is_empty() {
                conditions.push("EXISTS (SELECT 1 FROM media_tags mt JOIN tags t ON mt.tag_id = t.id WHERE mt.media_id = m.id AND t.name = ?)".to_string());
                params_vec.push(t.to_string().into());
            }
        }

        let where_clause = if conditions.is_empty() {
            "".to_string()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };

        let count_sql = format!("SELECT COUNT(*) FROM media m {}", where_clause);
        let total: i64 = {
            let mut stmt = conn.prepare(&count_sql)?;
            stmt.query_row(rusqlite::params_from_iter(params_vec.iter()), |r| r.get(0))?
        };

        let offset = page * page_size;
        let select_sql = format!(
            "SELECT m.id FROM media m {} ORDER BY m.modified_ms DESC, m.name ASC LIMIT ? OFFSET ?",
            where_clause
        );

        let mut select_params = params_vec;
        select_params.push(page_size.into());
        select_params.push(offset.into());

        let mut stmt = conn.prepare(&select_sql)?;
        let ids: Vec<String> = stmt
            .query_map(rusqlite::params_from_iter(select_params.iter()), |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut items = Vec::new();
        for id in ids {
            items.push(self.load_media_item_internal(&conn, &id)?);
        }

        Ok(LibraryPageResult {
            items,
            total,
            page,
            page_size,
        })
    }

    // Tags
    pub fn get_all_tags(&self) -> Result<Vec<String>, AppError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT name FROM tags ORDER BY name COLLATE NOCASE ASC")?;
        let tags: Vec<String> = stmt
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(tags)
    }

    pub fn set_media_tags(&self, media_id: &str, tag_names: &[String]) -> Result<(), AppError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;

        // Delete existing associations
        tx.execute("DELETE FROM media_tags WHERE media_id = ?1", params![media_id])?;

        for raw_tag in tag_names {
            let trimmed = raw_tag.trim();
            if trimmed.is_empty() {
                continue;
            }

            // Find or insert tag (case-insensitive)
            let tag_id: String = match tx
                .query_row(
                    "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
                    params![trimmed],
                    |r| r.get(0),
                )
                .optional()?
            {
                Some(id) => id,
                None => {
                    let id = Uuid::new_v4().to_string();
                    tx.execute(
                        "INSERT INTO tags (id, name) VALUES (?1, ?2)",
                        params![id, trimmed],
                    )?;
                    id
                }
            };

            tx.execute(
                "INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?1, ?2)",
                params![media_id, tag_id],
            )?;
        }

        // Clean up unreferenced tags
        tx.execute(
            "DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM media_tags)",
            [],
        )?;

        tx.commit()?;
        Ok(())
    }

    // Reviews (version 1)
    pub fn get_review(&self, media_id: &str) -> Result<Option<String>, AppError> {
        let conn = self.conn.lock();
        let doc: Option<String> = conn
            .query_row(
                "SELECT document_json FROM reviews WHERE media_id = ?1",
                params![media_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(doc)
    }

    pub fn save_review(&self, media_id: &str, document_json: &str) -> Result<(), AppError> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO reviews (media_id, document_json) VALUES (?1, ?2) ON CONFLICT(media_id) DO UPDATE SET document_json = excluded.document_json",
            params![media_id, document_json],
        )?;
        Ok(())
    }

    // Boards (version 1)
    pub fn list_boards(&self) -> Result<Vec<BoardSummary>, AppError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT id, name, document_json FROM boards ORDER BY name ASC")?;
        let rows = stmt.query_map([], |r| {
            let id: String = r.get(0)?;
            let name: String = r.get(1)?;
            let doc_str: String = r.get(2)?;
            let item_count = if let Ok(val) = serde_json::from_str::<serde_json::Value>(&doc_str) {
                val.get("items").and_then(|i| i.as_array()).map(|a| a.len() as i64).unwrap_or(0)
            } else {
                0
            };
            Ok(BoardSummary { id, name, item_count })
        })?;

        let mut boards = Vec::new();
        for r in rows {
            boards.push(r?);
        }
        Ok(boards)
    }

    pub fn get_board(&self, id: &str) -> Result<Option<String>, AppError> {
        let conn = self.conn.lock();
        let doc: Option<String> = conn
            .query_row("SELECT document_json FROM boards WHERE id = ?1", params![id], |r| r.get(0))
            .optional()?;
        Ok(doc)
    }

    pub fn save_board(&self, id: &str, name: &str, document_json: &str) -> Result<(), AppError> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO boards (id, name, document_json) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET name = excluded.name, document_json = excluded.document_json",
            params![id, name, document_json],
        )?;
        Ok(())
    }

    pub fn delete_board(&self, id: &str) -> Result<(), AppError> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM boards WHERE id = ?1", params![id])?;
        Ok(())
    }

    // Editors (version 1)
    pub fn list_editors(&self) -> Result<Vec<EditorSummary>, AppError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT id, name, document_json FROM editors ORDER BY name ASC")?;
        let rows = stmt.query_map([], |r| {
            let id: String = r.get(0)?;
            let name: String = r.get(1)?;
            let doc_str: String = r.get(2)?;
            let (width, height, layer_count) = if let Ok(val) = serde_json::from_str::<serde_json::Value>(&doc_str) {
                let w = val.get("width").and_then(|v| v.as_i64()).unwrap_or(1920) as i32;
                let h = val.get("height").and_then(|v| v.as_i64()).unwrap_or(1080) as i32;
                let lc = val.get("layers").and_then(|l| l.as_array()).map(|a| a.len() as i64).unwrap_or(1);
                (w, h, lc)
            } else {
                (1920, 1080, 1)
            };
            Ok(EditorSummary { id, name, width, height, layer_count })
        })?;

        let mut editors = Vec::new();
        for r in rows {
            editors.push(r?);
        }
        Ok(editors)
    }

    pub fn get_editor(&self, id: &str) -> Result<Option<String>, AppError> {
        let conn = self.conn.lock();
        let doc: Option<String> = conn
            .query_row("SELECT document_json FROM editors WHERE id = ?1", params![id], |r| r.get(0))
            .optional()?;
        Ok(doc)
    }

    pub fn save_editor(&self, id: &str, name: &str, document_json: &str) -> Result<(), AppError> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO editors (id, name, document_json) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET name = excluded.name, document_json = excluded.document_json",
            params![id, name, document_json],
        )?;
        Ok(())
    }

    pub fn delete_editor(&self, id: &str) -> Result<(), AppError> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM editors WHERE id = ?1", params![id])?;
        Ok(())
    }

    // Settings
    pub fn get_setting(&self, key: &str) -> Result<Option<String>, AppError> {
        let conn = self.conn.lock();
        let val: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
            .optional()?;
        Ok(val)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), AppError> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}
