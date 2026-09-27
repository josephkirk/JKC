use crate::db::{
    AppError, BoardSummary, Database, EditorSummary, LibraryPageResult, LibraryQuery, MediaItem,
    RootFolder,
};
use crate::media::{JobProgressEvent, MediaProcessor, SystemInfo};
use image::{GenericImageView, ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use walkdir::WalkDir;

pub struct AppState {
    pub db: Arc<Database>,
    pub media: Arc<MediaProcessor>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub last_view: String,
    pub last_media_id: Option<String>,
    pub last_board_id: Option<String>,
    pub last_editor_id: Option<String>,
    pub tools_dir: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsPatch {
    pub last_view: Option<String>,
    pub last_media_id: Option<Option<String>>,
    pub last_board_id: Option<Option<String>>,
    pub last_editor_id: Option<Option<String>>,
    pub tools_dir: Option<Option<String>>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            last_view: "library".to_string(),
            last_media_id: None,
            last_board_id: None,
            last_editor_id: None,
            tools_dir: None,
        }
    }
}

#[tauri::command]
pub fn exit_app(app: AppHandle) -> Result<(), AppError> {
    app.exit(0);
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub added: i64,
    pub updated: i64,
    pub missing: i64,
    pub skipped: i64,
    pub errors: Vec<String>,
}

// Review structs
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub id: String,
    pub time_ms: i64,
    pub text: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReviewTake {
    pub id: String,
    pub name: String,
    pub in_ms: i64,
    pub out_ms: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReviewStroke {
    pub id: String,
    pub tool: String,
    pub color: String,
    pub stroke_width: f64,
    pub points: Vec<NormalizedPoint>,
    pub text: Option<String>,
    pub font_size: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReviewAnnotation {
    pub id: String,
    pub time_ms: i64,
    pub strokes: Vec<ReviewStroke>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDocument {
    pub version: i32,
    pub media_id: String,
    pub comments: Vec<ReviewComment>,
    pub takes: Vec<ReviewTake>,
    pub shot_boundaries_ms: Vec<i64>,
    pub annotations: Vec<ReviewAnnotation>,
}

// Board structs
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BoardViewport {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BoardDocument {
    pub version: i32,
    pub id: String,
    pub name: String,
    pub viewport: BoardViewport,
    pub items: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excalidraw_scene: Option<serde_json::Value>,
}

// Editor structs
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EditorLayer {
    pub id: String,
    pub name: String,
    pub visible: bool,
    pub opacity: f64,
    pub asset_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EditorDocument {
    pub version: i32,
    pub id: String,
    pub name: String,
    pub width: i32,
    pub height: i32,
    pub layers: Vec<EditorLayer>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStillRequest {
    pub media_id: String,
    pub time_ms: i64,
    pub target_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTakeRequest {
    pub media_id: String,
    pub in_ms: i64,
    pub out_ms: i64,
    pub format: String,
    pub target_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorExportRequest {
    pub editor_id: String,
    pub format: String,
    pub target_path: String,
    pub quality: Option<f32>,
}

const SUPPORTED_IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp", "gif", "jp2", "j2k", "jpf", "jpx", "pdf"];
const SUPPORTED_VIDEO_EXTS: &[&str] = &["mp4", "mov", "mkv", "webm", "avi", "m4v"];
const MAX_EDITOR_PIXELS: i64 = 16_777_216; // 4096 * 4096 or equivalent
pub const ASSET_ORIGIN: &str = "http://jkc-asset.localhost";

// System & Settings
#[tauri::command]
pub fn get_system_info(state: State<AppState>) -> Result<SystemInfo, AppError> {
    Ok(state.media.get_system_info())
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Result<AppSettings, AppError> {
    let raw = state.db.get_setting("app_settings")?;
    match raw {
        Some(json_str) => serde_json::from_str(&json_str).map_err(AppError::from),
        None => Ok(AppSettings::default()),
    }
}

#[tauri::command]
pub fn save_settings(
    state: State<AppState>,
    settings: AppSettingsPatch,
) -> Result<(), AppError> {
    let mut current = get_settings(state.clone())?;

    if let Some(view) = settings.last_view {
        current.last_view = view;
    }
    if let Some(m_id) = settings.last_media_id {
        current.last_media_id = m_id;
    }
    if let Some(b_id) = settings.last_board_id {
        current.last_board_id = b_id;
    }
    if let Some(e_id) = settings.last_editor_id {
        current.last_editor_id = e_id;
    }
    if let Some(td) = settings.tools_dir {
        if let Some(dir) = &td {
            if !dir.trim().is_empty() {
                state.media.set_tools_dir(Some(PathBuf::from(dir)));
            } else {
                state.media.set_tools_dir(None);
            }
        } else {
            state.media.set_tools_dir(None);
        }
        current.tools_dir = td;
    }

    let json_str = serde_json::to_string(&current)?;
    state.db.set_setting("app_settings", &json_str)?;
    Ok(())
}

#[tauri::command]
pub fn set_tools_dir(
    state: State<AppState>,
    tools_dir: String,
) -> Result<SystemInfo, AppError> {
    let p = if tools_dir.trim().is_empty() {
        None
    } else {
        Some(PathBuf::from(&tools_dir))
    };
    state.media.set_tools_dir(p);
    let patch = AppSettingsPatch {
        tools_dir: Some(if tools_dir.trim().is_empty() {
            None
        } else {
            Some(tools_dir)
        }),
        ..Default::default()
    };
    save_settings(state.clone(), patch)?;
    Ok(state.media.get_system_info())
}

// Roots & Library
#[tauri::command]
pub fn list_roots(state: State<AppState>) -> Result<Vec<RootFolder>, AppError> {
    state.db.list_roots()
}

#[tauri::command]
pub async fn add_root_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<RootFolder, AppError> {
    let root = state.db.add_root(&path)?;
    let root_id = root.id.clone();
    let scan_root_id = root_id.clone();
    let db = Arc::clone(&state.db);
    let media = Arc::clone(&state.media);
    tauri::async_runtime::spawn_blocking(move || {
        let worker_state = AppState { db, media };
        scan_root_internal(&app, &worker_state, &scan_root_id)
    })
    .await
    .map_err(|e| AppError::with_details("BACKGROUND_JOB_FAILED", "Library scan stopped unexpectedly", e.to_string()))??;
    let updated = state.db.get_root(&root_id)?.unwrap_or(root);
    Ok(updated)
}

#[tauri::command]
pub fn remove_root_folder(
    state: State<AppState>,
    root_id: String,
) -> Result<(), AppError> {
    state.db.remove_root(&root_id)
}

#[tauri::command]
pub async fn scan_root(
    app: AppHandle,
    state: State<'_, AppState>,
    root_id: String,
) -> Result<ScanSummary, AppError> {
    let db = Arc::clone(&state.db);
    let media = Arc::clone(&state.media);
    tauri::async_runtime::spawn_blocking(move || {
        let worker_state = AppState { db, media };
        scan_root_internal(&app, &worker_state, &root_id)
    })
    .await
    .map_err(|e| AppError::with_details("BACKGROUND_JOB_FAILED", "Library scan stopped unexpectedly", e.to_string()))?
}

#[tauri::command]
pub async fn refresh_library(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ScanSummary, AppError> {
    let db = Arc::clone(&state.db);
    let media = Arc::clone(&state.media);
    tauri::async_runtime::spawn_blocking(move || {
        let worker_state = AppState { db, media };
        let roots = worker_state.db.list_roots()?;
        let mut total_summary = ScanSummary {
            added: 0,
            updated: 0,
            missing: 0,
            skipped: 0,
            errors: Vec::new(),
        };

        for root in roots {
            if let Ok(sum) = scan_root_internal(&app, &worker_state, &root.id) {
                total_summary.added += sum.added;
                total_summary.updated += sum.updated;
                total_summary.missing += sum.missing;
                total_summary.skipped += sum.skipped;
                total_summary.errors.extend(sum.errors);
            }
        }

        Ok(total_summary)
    })
    .await
    .map_err(|e| AppError::with_details("BACKGROUND_JOB_FAILED", "Library refresh stopped unexpectedly", e.to_string()))?
}

fn scan_root_internal(
    app: &AppHandle,
    state: &AppState,
    root_id: &str,
) -> Result<ScanSummary, AppError> {
    let root = state
        .db
        .get_root(root_id)?
        .ok_or_else(|| AppError::new("NOT_FOUND", "Root folder not found"))?;

    let root_path = PathBuf::from(&root.path);
    if !root_path.exists() {
        return Ok(ScanSummary {
            added: 0,
            updated: 0,
            missing: 0,
            skipped: 0,
            errors: vec![format!("Root directory does not exist: {}", root.path)],
        });
    }

    let canon_root = match root_path.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            return Ok(ScanSummary {
                added: 0,
                updated: 0,
                missing: 0,
                skipped: 0,
                errors: vec![format!("Could not canonicalize root directory: {}", e)],
            });
        }
    };
    let _ = app.emit(
        "jkc://job-progress",
        JobProgressEvent {
            job_id: format!("scan_{}", root_id),
            job_type: "scan".to_string(),
            target_id: root_id.to_string(),
            status: "running".to_string(),
            progress: 0.1,
            message: Some(format!("Scanning {}...", root.name)),
            output_file_path: None,
        },
    );

    let mut found_paths = Vec::new();
    let mut added = 0i64;
    let mut updated = 0i64;
    let mut skipped = 0i64;
    let mut errors = Vec::new();

    // Walk folder without following symlinks or junctions
    for entry_res in WalkDir::new(&root_path).follow_links(false).into_iter() {
        let entry = match entry_res {
            Ok(e) => e,
            Err(err) => {
                skipped += 1;
                errors.push(format!("Inaccessible file entry: {}", err));
                continue;
            }
        };

        if !entry.file_type().is_file() {
            continue;
        }

        let file_path = entry.path();
        let canon_file = match file_path.canonicalize() {
            Ok(p) => p,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        if !canon_file.starts_with(&canon_root) {
            skipped += 1;
            errors.push(format!("File outside authorized root boundary: {}", file_path.display()));
            continue;
        }
        let ext = file_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        let is_img = SUPPORTED_IMAGE_EXTS.contains(&ext.as_str());
        let is_vid = SUPPORTED_VIDEO_EXTS.contains(&ext.as_str());

        if !is_img && !is_vid {
            continue;
        }

        let kind = if is_img { "image" } else { "video" };
        let metadata = match file_path.metadata() {
            Ok(m) => m,
            Err(e) => {
                skipped += 1;
                errors.push(format!("Could not read metadata for {}: {}", file_path.display(), e));
                continue;
            }
        };

        let size_bytes = metadata.len() as i64;
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        let clean_path = file_path
            .canonicalize()
            .map(|p| {
                let s = p.to_string_lossy().to_string();
                if s.starts_with(r"\\?\") {
                    s[4..].to_string()
                } else {
                    s
                }
            })
            .unwrap_or_else(|_| file_path.to_string_lossy().to_string());

        found_paths.push(clean_path.clone());

        let name = file_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| clean_path.clone());

        // Check if existing
        let existing = state.db.get_media_by_path(&clean_path)?;
        let content_hash = match state.media.compute_file_hash(file_path) {
            Ok(h) => h,
            Err(e) => {
                skipped += 1;
                errors.push(format!("Failed to compute hash for {}: {}", file_path.display(), e.message));
                continue;
            }
        };

        let needs_probe = match &existing {
            Some(ex) => {
                ex.size_bytes != size_bytes
                    || ex.modified_ms != modified_ms
                    || ex.content_hash.as_deref() != Some(&content_hash)
                    || ex.width.is_none()
            }
            None => true,
        };

        let item = state.db.upsert_media(
            root_id,
            &clean_path,
            kind,
            &name,
            size_bytes,
            modified_ms,
            Some(&content_hash),
        )?;
        if existing.is_none() {
            added += 1;
        } else if needs_probe {
            updated += 1;
        }

        if needs_probe {
            // Probe media dimensions and duration
            if let Ok((w, h, dur)) = state.media.probe_media(file_path, kind) {
                let _ = state.db.update_media_metadata(&item.id, w, h, dur);
            }
            // Generate thumbnail in background cache
            let _ = state.media.get_or_generate_thumbnail(&item.id, file_path, kind, size_bytes, modified_ms);
        }
    }

    // Mark missing
    let missing_count = state.db.mark_media_missing_in_root(root_id, &found_paths)? as i64;

    let _ = app.emit(
        "jkc://job-progress",
        JobProgressEvent {
            job_id: format!("scan_{}", root_id),
            job_type: "scan".to_string(),
            target_id: root_id.to_string(),
            status: "completed".to_string(),
            progress: 1.0,
            message: Some(format!("Scan complete: {} added, {} missing", added, missing_count)),
            output_file_path: None,
        },
    );

    Ok(ScanSummary {
        added,
        updated,
        missing: missing_count,
        skipped,
        errors,
    })
}

#[tauri::command]
pub fn query_media(
    state: State<AppState>,
    query: LibraryQuery,
) -> Result<LibraryPageResult, AppError> {
    let mut result = state.db.query_media(&query)?;
    for item in &mut result.items {
        item.thumbnail_url = Some(format!("{}/thumb/{}", ASSET_ORIGIN, item.id));
        item.asset_url = Some(format!("{}/media/{}", ASSET_ORIGIN, item.id));
        let proxy_path = state.media.get_proxy_path(&item.id);
        if proxy_path.exists() {
            item.has_proxy = true;
            item.proxy_url = Some(format!("{}/proxy/{}", ASSET_ORIGIN, item.id));
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn get_media(
    state: State<AppState>,
    id: String,
) -> Result<MediaItem, AppError> {
    let mut item = state.db.get_media(&id)?;
    item.thumbnail_url = Some(format!("{}/thumb/{}", ASSET_ORIGIN, item.id));
    item.asset_url = Some(format!("{}/media/{}", ASSET_ORIGIN, item.id));
    let proxy_path = state.media.get_proxy_path(&item.id);
    if proxy_path.exists() {
        item.has_proxy = true;
        item.proxy_url = Some(format!("{}/proxy/{}", ASSET_ORIGIN, item.id));
    }
    Ok(item)
}

#[tauri::command]
pub fn set_favorite(
    state: State<AppState>,
    id: String,
    favorite: bool,
) -> Result<(), AppError> {
    state.db.set_favorite(&id, favorite)
}
#[tauri::command]
pub fn set_tags(
    state: State<AppState>,
    media_id: String,
    tags: Vec<String>,
) -> Result<(), AppError> {
    state.db.set_media_tags(&media_id, &tags)
}

#[tauri::command]
pub fn get_all_tags(state: State<AppState>) -> Result<Vec<String>, AppError> {
    state.db.get_all_tags()
}

fn validate_relink_source(
    new_path: &str,
    expected_kind: &str,
) -> Result<PathBuf, AppError> {
    let path = Path::new(new_path);
    let canonical = path
        .canonicalize()
        .map_err(|_| AppError::new("FILE_NOT_FOUND", "Relink destination does not exist"))?;
    if !canonical.is_file() {
        return Err(AppError::new("INVALID_MEDIA", "Relink destination must be a regular media file"));
    }

    let ext = canonical
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let supported = match expected_kind {
        "image" => SUPPORTED_IMAGE_EXTS.contains(&ext.as_str()),
        "video" => SUPPORTED_VIDEO_EXTS.contains(&ext.as_str()),
        _ => false,
    };
    if !supported {
        return Err(AppError::new("UNSUPPORTED_MEDIA", "Relink destination has an unsupported media type"));
    }
    Ok(canonical)
}


#[tauri::command]
pub async fn pick_relink_media(
    app: AppHandle,
    state: State<'_, AppState>,
    media_id: String,
) -> Result<Option<MediaItem>, AppError> {
    let existing = state.db.get_media(&media_id)?;
    let extensions = if existing.kind == "image" {
        vec!["jpg", "jpeg", "png", "webp", "bmp", "gif"]
    } else {
        SUPPORTED_VIDEO_EXTS.to_vec()
    };
    let selected = app
        .dialog()
        .file()
        .add_filter(if existing.kind == "image" { "Images" } else { "Videos" }, &extensions)
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let selected_path = selected
        .into_path()
        .map_err(|e| AppError::with_details("INVALID_SELECTION", "Selected path is not a local file", e.to_string()))?;

    let expected_kind = existing.kind.clone();
    let db = Arc::clone(&state.db);
    let media = Arc::clone(&state.media);
    let item = tauri::async_runtime::spawn_blocking(move || -> Result<MediaItem, AppError> {
        let selected_path_string = selected_path.to_string_lossy().to_string();
        let canonical = validate_relink_source(&selected_path_string, &expected_kind)?;
        let metadata = canonical.metadata()?;
        let size_bytes = metadata.len() as i64;
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);
        let (width, height, duration_ms) = media.probe_media(&canonical, &expected_kind)
            .map_err(|error| AppError::with_details("INVALID_MEDIA", "Selected file could not be decoded or probed", error.message))?;
        let hash = media.compute_file_hash(&canonical)?;
        let _ = media.get_or_generate_thumbnail(
            &media_id,
            &canonical,
            &expected_kind,
            size_bytes,
            modified_ms,
        )?;
        let canonical_path = canonical.to_string_lossy().to_string();
        let mut item = db.relink_media(&media_id, &canonical_path, Some(&hash))?;
        db.update_media_metadata(&item.id, width, height, duration_ms)?;
        item.width = width;
        item.height = height;
        item.duration_ms = duration_ms;
        item.size_bytes = size_bytes;
        item.modified_ms = modified_ms;
        item.thumbnail_url = Some(format!("{}/thumb/{}", ASSET_ORIGIN, item.id));
        item.asset_url = Some(format!("{}/media/{}", ASSET_ORIGIN, item.id));
        Ok(item)
    })
    .await
    .map_err(|e| AppError::with_details("BACKGROUND_JOB_FAILED", "Relink stopped unexpectedly", e.to_string()))??;
    Ok(Some(item))
}

// Reviews
#[tauri::command]
pub fn get_review(
    state: State<AppState>,
    media_id: String,
) -> Result<ReviewDocument, AppError> {
    if let Some(json_str) = state.db.get_review(&media_id)? {
        if let Ok(doc) = serde_json::from_str::<ReviewDocument>(&json_str) {
            return Ok(doc);
        }
    }

    Ok(ReviewDocument {
        version: 1,
        media_id,
        comments: Vec::new(),
        takes: Vec::new(),
        shot_boundaries_ms: Vec::new(),
        annotations: Vec::new(),
    })
}

#[tauri::command]
pub fn save_review(
    state: State<AppState>,
    review: ReviewDocument,
) -> Result<(), AppError> {
    let json_str = serde_json::to_string(&review)?;
    state.db.save_review(&review.media_id, &json_str)
}

#[tauri::command]
pub fn generate_proxy(
    app: AppHandle,
    state: State<AppState>,
    media_id: String,
) -> Result<String, AppError> {
    let media = state.db.get_media(&media_id)?;
    let job_id = uuid::Uuid::new_v4().to_string();
    state.media.generate_proxy(app, &job_id, &media_id, Path::new(&media.path))
}

#[tauri::command]
pub async fn capture_still(
    state: State<'_, AppState>,
    req: CaptureStillRequest,
) -> Result<(), AppError> {
    let media = state.db.get_media(&req.media_id)?;
    let duration_ms = media.duration_ms.ok_or_else(|| {
        AppError::new("DURATION_UNKNOWN", "Media duration is required before still capture")
    })?;
    if req.time_ms < 0 || req.time_ms > duration_ms {
        return Err(AppError::new("INVALID_TIME", "Still capture time must be within the media duration"));
    }
    let processor = Arc::clone(&state.media);
    tauri::async_runtime::spawn_blocking(move || {
        processor.capture_still(Path::new(&media.path), req.time_ms, Path::new(&req.target_path))
    })
    .await
    .map_err(|e| AppError::with_details("BACKGROUND_JOB_FAILED", "Still capture stopped unexpectedly", e.to_string()))?
}

#[tauri::command]
pub fn export_take(
    app: AppHandle,
    state: State<AppState>,
    req: ExportTakeRequest,
) -> Result<String, AppError> {
    let media = state.db.get_media(&req.media_id)?;
    let duration_ms = media.duration_ms.ok_or_else(|| {
        AppError::new("DURATION_UNKNOWN", "Media duration is required before export")
    })?;
    if req.in_ms < 0 || req.out_ms <= req.in_ms || req.out_ms > duration_ms {
        return Err(AppError::new(
            "INVALID_RANGE",
            "Export range must be within the media duration and out-point must be greater than in-point",
        ));
    }
    let job_id = uuid::Uuid::new_v4().to_string();
    state.media.export_take(
        app,
        &job_id,
        &req.media_id,
        Path::new(&media.path),
        req.in_ms,
        req.out_ms,
        &req.format,
        Path::new(&req.target_path),
    )
}

#[tauri::command]
pub async fn detect_shots(
    state: State<'_, AppState>,
    media_id: String,
) -> Result<Vec<i64>, AppError> {
    let media = state.db.get_media(&media_id)?;
    let dur = media.duration_ms.unwrap_or(0);
    if dur <= 0 {
        return Ok(vec![0]);
    }
    let processor = Arc::clone(&state.media);
    tauri::async_runtime::spawn_blocking(move || processor.detect_shots(Path::new(&media.path), dur))
        .await
        .map_err(|e| AppError::with_details("BACKGROUND_JOB_FAILED", "Shot detection stopped unexpectedly", e.to_string()))?
}

#[tauri::command]
pub fn cancel_job(
    state: State<AppState>,
    job_id: String,
) -> Result<(), AppError> {
    state.media.cancel_job(&job_id)
}

// Boards
#[tauri::command]
pub fn list_boards(state: State<AppState>) -> Result<Vec<BoardSummary>, AppError> {
    state.db.list_boards()
}

#[tauri::command]
pub fn get_board(
    state: State<AppState>,
    id: String,
) -> Result<BoardDocument, AppError> {
    let doc_str = state
        .db
        .get_board(&id)?
        .ok_or_else(|| AppError::new("NOT_FOUND", "Board not found"))?;
    let doc: BoardDocument = serde_json::from_str(&doc_str)?;
    Ok(doc)
}

#[tauri::command]
pub fn save_board(
    state: State<AppState>,
    board: BoardDocument,
) -> Result<(), AppError> {
    let json_str = serde_json::to_string(&board)?;
    state.db.save_board(&board.id, &board.name, &json_str)
}

#[tauri::command]
pub fn create_board(
    state: State<AppState>,
    name: String,
) -> Result<BoardDocument, AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let board = BoardDocument {
        version: 1,
        id: id.clone(),
        name: name.clone(),
        viewport: BoardViewport {
            x: 0.0,
            y: 0.0,
            scale: 1.0,
        },
        items: Vec::new(),
        excalidraw_scene: None,
    };
    let json_str = serde_json::to_string(&board)?;
    state.db.save_board(&id, &name, &json_str)?;
    Ok(board)
}

#[tauri::command]
pub fn delete_board(
    state: State<AppState>,
    id: String,
) -> Result<(), AppError> {
    state.db.delete_board(&id)
}

// Editors
#[tauri::command]
pub fn list_editors(state: State<AppState>) -> Result<Vec<EditorSummary>, AppError> {
    state.db.list_editors()
}

#[tauri::command]
pub fn get_editor(
    state: State<AppState>,
    id: String,
) -> Result<EditorDocument, AppError> {
    let doc_str = state
        .db
        .get_editor(&id)?
        .ok_or_else(|| AppError::new("NOT_FOUND", "Editor document not found"))?;
    let doc: EditorDocument = serde_json::from_str(&doc_str)?;
    Ok(doc)
}

#[tauri::command]
pub fn save_editor(
    state: State<AppState>,
    editor: EditorDocument,
) -> Result<(), AppError> {
    let json_str = serde_json::to_string(&editor)?;
    state.db.save_editor(&editor.id, &editor.name, &json_str)
}

#[tauri::command]
pub fn create_editor(
    state: State<AppState>,
    name: String,
    width: i32,
    height: i32,
) -> Result<EditorDocument, AppError> {
    if width <= 0 || height <= 0 {
        return Err(AppError::new("INVALID_DIMENSIONS", "Width and height must be positive integers"));
    }
    let total_pixels = (width as i64) * (height as i64);
    if total_pixels > MAX_EDITOR_PIXELS {
        return Err(AppError::new("DIMENSION_LIMIT", "Image dimensions exceed 16,777,216 pixel limit"));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let layer_asset_id = format!("layer_{}.png", uuid::Uuid::new_v4());
    let layer_path = state.media.editor_assets_dir().join(&layer_asset_id);

    // Create transparent PNG for initial layer
    let blank_img = RgbaImage::new(width as u32, height as u32);
    blank_img.save_with_format(&layer_path, ImageFormat::Png).map_err(|e| {
        AppError::with_details("LAYER_INIT_FAILED", "Failed to create initial layer asset", e.to_string())
    })?;

    let doc = EditorDocument {
        version: 1,
        id: id.clone(),
        name: name.clone(),
        width,
        height,
        layers: vec![EditorLayer {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Background".to_string(),
            visible: true,
            opacity: 1.0,
            asset_id: layer_asset_id,
        }],
    };

    let json_str = serde_json::to_string(&doc)?;
    state.db.save_editor(&id, &name, &json_str)?;
    Ok(doc)
}

#[tauri::command]
pub fn create_editor_from_media(
    state: State<AppState>,
    media_id: String,
) -> Result<EditorDocument, AppError> {
    let media = state.db.get_media(&media_id)?;
    let media_path = Path::new(&media.path);
    if !media_path.exists() {
        return Err(AppError::new("FILE_NOT_FOUND", "Media file not found"));
    }

    let img = image::open(media_path).map_err(|e| {
        AppError::with_details("IMAGE_DECODE_FAILED", "Could not decode media into editor layer", e.to_string())
    })?;

    let (w, h) = img.dimensions();
    let total_pixels = (w as i64) * (h as i64);
    if total_pixels > MAX_EDITOR_PIXELS {
        return Err(AppError::new("DIMENSION_LIMIT", "Image dimensions exceed 16,777,216 pixel limit"));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let layer_asset_id = format!("layer_{}.png", uuid::Uuid::new_v4());
    let layer_path = state.media.editor_assets_dir().join(&layer_asset_id);

    img.save_with_format(&layer_path, ImageFormat::Png).map_err(|e| {
        AppError::with_details("LAYER_SAVE_FAILED", "Failed to save imported layer", e.to_string())
    })?;

    let doc = EditorDocument {
        version: 1,
        id: id.clone(),
        name: media.name.clone(),
        width: w as i32,
        height: h as i32,
        layers: vec![EditorLayer {
            id: uuid::Uuid::new_v4().to_string(),
            name: media.name,
            visible: true,
            opacity: 1.0,
            asset_id: layer_asset_id,
        }],
    };

    let json_str = serde_json::to_string(&doc)?;
    state.db.save_editor(&id, &doc.name, &json_str)?;
    Ok(doc)
}

#[tauri::command]
pub fn delete_editor(
    state: State<AppState>,
    id: String,
) -> Result<(), AppError> {
    // Delete editor record
    state.db.delete_editor(&id)
}

#[tauri::command]
pub fn save_layer_raster(
    state: State<AppState>,
    asset_id: String,
    png_bytes_base64: String,
) -> Result<String, AppError> {
    // Basic alphanumeric & period check for asset_id to prevent directory traversal
    if !asset_id.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '.') {
        return Err(AppError::new("INVALID_ASSET_ID", "Invalid asset filename"));
    }

    // Decode base64
    let clean_b64 = if let Some(idx) = png_bytes_base64.find("base64,") {
        &png_bytes_base64[idx + 7..]
    } else {
        &png_bytes_base64
    };

    // Fast base64 decode
    let bytes = match decode_base64(clean_b64) {
        Ok(b) => b,
        Err(e) => return Err(AppError::with_details("DECODE_ERROR", "Invalid base64 payload", e)),
    };

    let target_path = state.media.editor_assets_dir().join(&asset_id);
    let temp_path = target_path.with_extension(format!("tmp_{}.png", uuid::Uuid::new_v4()));

    std::fs::write(&temp_path, &bytes)?;
    crate::media::atomic_replace(&temp_path, &target_path)?;
    Ok(asset_id)
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut buf: u32 = 0;
    let mut bits = 0;

    for byte in input.bytes() {
        let val = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' | b' ' => continue,
            _ => return Err(format!("Invalid character in base64: {}", byte as char)),
        };

        buf = (buf << 6) | (val as u32);
        bits += 6;

        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }

    Ok(out)
}

#[tauri::command]
pub fn export_editor_composite(
    state: State<AppState>,
    req: EditorExportRequest,
) -> Result<(), AppError> {
    let editor_doc = get_editor(state.clone(), req.editor_id)?;
    let target = Path::new(&req.target_path);

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let w = editor_doc.width as u32;
    let h = editor_doc.height as u32;

    // Buffer for final composite
    let mut composite = RgbaImage::new(w, h);

    // Composite visible layers from bottom to top
    for layer in &editor_doc.layers {
        if !layer.visible || layer.opacity <= 0.0 {
            continue;
        }

        let layer_path = state.media.editor_assets_dir().join(&layer.asset_id);
        if !layer_path.exists() {
            continue;
        }

        if let Ok(layer_img) = image::open(&layer_path) {
            let layer_rgba = layer_img.to_rgba8();
            let opacity = layer.opacity.clamp(0.0, 1.0) as f32;

            for y in 0..h {
                for x in 0..w {
                    if x >= layer_rgba.width() || y >= layer_rgba.height() {
                        continue;
                    }
                    let top_p = layer_rgba.get_pixel(x, y);
                    let top_a = (top_p[3] as f32 / 255.0) * opacity;
                    if top_a <= 0.0 {
                        continue;
                    }

                    let bot_p = composite.get_pixel(x, y);
                    let bot_a = bot_p[3] as f32 / 255.0;

                    let out_a = top_a + bot_a * (1.0 - top_a);
                    if out_a > 0.0 {
                        let r = (top_p[0] as f32 * top_a + bot_p[0] as f32 * bot_a * (1.0 - top_a)) / out_a;
                        let g = (top_p[1] as f32 * top_a + bot_p[1] as f32 * bot_a * (1.0 - top_a)) / out_a;
                        let b = (top_p[2] as f32 * top_a + bot_p[2] as f32 * bot_a * (1.0 - top_a)) / out_a;

                        composite.put_pixel(
                            x,
                            y,
                            image::Rgba([
                                r.round() as u8,
                                g.round() as u8,
                                b.round() as u8,
                                (out_a * 255.0).round() as u8,
                            ]),
                        );
                    }
                }
            }
        }
    }

    let temp_target = target.with_extension(format!("tmp_{}.{}", uuid::Uuid::new_v4(), req.format));

    if req.format.to_lowercase() == "jpeg" || req.format.to_lowercase() == "jpg" {
        // Flatten on white background
        let mut rgb_img = image::RgbImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let p = composite.get_pixel(x, y);
                let alpha = p[3] as f32 / 255.0;
                let r = (p[0] as f32 * alpha + 255.0 * (1.0 - alpha)).round() as u8;
                let g = (p[1] as f32 * alpha + 255.0 * (1.0 - alpha)).round() as u8;
                let b = (p[2] as f32 * alpha + 255.0 * (1.0 - alpha)).round() as u8;
                rgb_img.put_pixel(x, y, image::Rgb([r, g, b]));
            }
        }
        rgb_img
            .save_with_format(&temp_target, ImageFormat::Jpeg)
            .map_err(|e| AppError::with_details("EXPORT_FAILED", "Failed to save JPEG composite", e.to_string()))?;
    } else {
        composite
            .save_with_format(&temp_target, ImageFormat::Png)
            .map_err(|e| AppError::with_details("EXPORT_FAILED", "Failed to save PNG composite", e.to_string()))?;
    }
    crate::media::atomic_replace(&temp_target, target)?;
    Ok(())
}

#[cfg(test)]
mod relink_authorization_tests {
    use super::validate_relink_source;
    use tempfile::tempdir;

    #[test]
    fn relink_file_validation_accepts_supported_regular_files() {
        let dir = tempdir().unwrap();
        let image = dir.path().join("replacement.png");
        image::RgbaImage::new(2, 2).save(&image).unwrap();
        assert!(validate_relink_source(image.to_str().unwrap(), "image").is_ok());
    }

    #[test]
    fn relink_file_validation_rejects_wrong_kind_and_missing_files() {
        let dir = tempdir().unwrap();
        let image = dir.path().join("replacement.png");
        image::RgbaImage::new(2, 2).save(&image).unwrap();
        assert!(validate_relink_source(image.to_str().unwrap(), "video").is_err());
        assert!(validate_relink_source(dir.path().join("missing.png").to_str().unwrap(), "image").is_err());
    }
}
