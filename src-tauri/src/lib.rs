pub mod commands;
pub mod db;
pub mod media;

use commands::*;
use db::Database;
use media::MediaProcessor;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::http::{header, Response, StatusCode};
use tauri::Manager;

pub fn get_app_data_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(override_dir) = std::env::var("JKC_DATA_DIR") {
        if !override_dir.trim().is_empty() {
            return PathBuf::from(override_dir);
        }
    }
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("./jkc_data"))
}

fn guess_mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "jp2" | "j2k" | "jpf" | "jpx" => "image/jp2",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        _ => "application/octet-stream",
    }
}

fn serve_file(path: &Path, req_range: Option<&str>) -> Response<Vec<u8>> {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Vec::new())
                .unwrap();
        }
    };

    let total_len = match file.metadata().map(|m| m.len()) {
        Ok(l) => l,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Vec::new())
                .unwrap();
        }
    };

    let mime = guess_mime(path);

    // Handle HTTP Range header for video seeking
    if let Some(range_header) = req_range {
        if let Some(spec) = range_header.strip_prefix("bytes=") {
            let mut parts = spec.split('-');
            let start: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            let end: u64 = parts
                .next()
                .and_then(|s| if s.is_empty() { None } else { s.parse().ok() })
                .unwrap_or(total_len.saturating_sub(1));

            let end = end.min(total_len.saturating_sub(1));
            if start <= end && start < total_len {
                let chunk_size = (end - start + 1) as usize;
                let mut buf = vec![0u8; chunk_size];
                if file.seek(SeekFrom::Start(start)).is_ok() && file.read_exact(&mut buf).is_ok() {
                    return Response::builder()
                        .status(StatusCode::PARTIAL_CONTENT)
                        .header(header::CONTENT_TYPE, mime)
                        .header(header::ACCEPT_RANGES, "bytes")
                        .header(
                            header::CONTENT_RANGE,
                            format!("bytes {}-{}/{}", start, end, total_len),
                        )
                        .header(header::CONTENT_LENGTH, chunk_size.to_string())
                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                        .body(buf)
                        .unwrap();
                }
            }
        }
    }

    // Default full read
    let mut full_buf = Vec::with_capacity(total_len as usize);
    let _ = file.read_to_end(&mut full_buf);

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, full_buf.len().to_string())
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(full_buf)
        .unwrap()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("jkc-asset", |ctx, req, responder| {
            let state = ctx.app_handle().state::<AppState>();
            let path_and_query = req.uri().path();
            let range_header = req
                .headers()
                .get(header::RANGE)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());

            let mut segments = path_and_query.trim_start_matches('/').split('/');
            let kind = segments.next().unwrap_or("");
            let target_id = segments.next().unwrap_or("");

            match kind {
                "media" => {
                    let media_res = state.db.get_media(target_id);
                    match media_res {
                        Ok(media) => {
                            let file_path = PathBuf::from(&media.path);
                            let canon_file = match file_path.canonicalize() {
                                Ok(p) => p,
                                Err(_) => {
                                    responder.respond(Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap());
                                    return;
                                }
                            };
                            if media.missing {
                                responder.respond(Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap());
                                return;
                            }
                            responder.respond(serve_file(&canon_file, range_header.as_deref()));
                        }
                        Err(_) => {
                            responder.respond(
                                Response::builder()
                                    .status(StatusCode::NOT_FOUND)
                                    .body(Vec::new())
                                    .unwrap(),
                            );
                        }
                    }
                }
                "thumb" => {
                    let media_res = state.db.get_media(target_id);
                    match media_res {
                        Ok(media) => {
                            let processor = state.media.clone();
                            let media_id = media.id.clone();
                            tauri::async_runtime::spawn_blocking(move || {
                                let thumb_res = processor.get_or_generate_thumbnail(
                                    &media_id,
                                    Path::new(&media.path),
                                    &media.kind,
                                    media.size_bytes,
                                    media.modified_ms,
                                );
                                match thumb_res {
                                    Ok(thumb_path) => responder.respond(serve_file(&thumb_path, None)),
                                    Err(_) => responder.respond(
                                        Response::builder()
                                            .status(StatusCode::NOT_FOUND)
                                            .body(Vec::new())
                                            .unwrap(),
                                    ),
                                }
                            });
                        }
                        Err(_) => {
                            responder.respond(
                                Response::builder()
                                    .status(StatusCode::NOT_FOUND)
                                    .body(Vec::new())
                                    .unwrap(),
                            );
                        }
                    }
                }
                "proxy" => {
                    let proxy_path = state.media.get_proxy_path(target_id);
                    responder.respond(serve_file(&proxy_path, range_header.as_deref()));
                }
                "editor" => {
                    // Prevent path traversal
                    if target_id.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '.') {
                        let asset_path = state.media.editor_assets_dir().join(target_id);
                        responder.respond(serve_file(&asset_path, None));
                    } else {
                        responder.respond(
                            Response::builder()
                                .status(StatusCode::BAD_REQUEST)
                                .body(Vec::new())
                                .unwrap(),
                        );
                    }
                }
                _ => {
                    responder.respond(
                        Response::builder()
                            .status(StatusCode::NOT_FOUND)
                            .body(Vec::new())
                            .unwrap(),
                    );
                }
            }
        })
        .setup(|app| {
            let app_data_dir = get_app_data_dir(app.handle());
            std::fs::create_dir_all(&app_data_dir).expect("failed to create app data directory");

            let db_path = app_data_dir.join("jkc.sqlite3");
            let db = Database::new(&db_path).expect("failed to initialize database");
            let media = MediaProcessor::new(&app_data_dir).expect("failed to initialize media processor");

            // Restore user tools dir from settings if saved
            if let Ok(Some(settings_str)) = db.get_setting("app_settings") {
                if let Ok(settings) = serde_json::from_str::<AppSettings>(&settings_str) {
                    if let Some(ref dir) = settings.tools_dir {
                        media.set_tools_dir(Some(PathBuf::from(dir)));
                    }
                }
            }

            app.manage(AppState { db, media });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            exit_app,
            get_system_info,
            get_settings,
            set_tools_dir,
            list_roots,
            add_root_folder,
            remove_root_folder,
            scan_root,
            refresh_library,
            query_media,
            get_media,
            set_favorite,
            set_tags,
            get_all_tags,
            pick_relink_media,
            get_review,
            save_review,
            generate_proxy,
            capture_still,
            export_take,
            detect_shots,
            cancel_job,
            list_boards,
            get_board,
            save_board,
            create_board,
            delete_board,
            list_editors,
            get_editor,
            save_editor,
            create_editor,
            create_editor_from_media,
            delete_editor,
            save_layer_raster,
            export_editor_composite,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
