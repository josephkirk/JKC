use crate::db::AppError;
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub ffmpeg_available: bool,
    pub ffmpeg_version: Option<String>,
    pub ffprobe_available: bool,
    pub ffprobe_version: Option<String>,
    pub resolved_ffmpeg_path: Option<String>,
    pub resolved_ffprobe_path: Option<String>,
    pub app_data_dir: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JobProgressEvent {
    pub job_id: String,
    pub job_type: String,
    pub target_id: String,
    pub status: String,
    pub progress: f64,
    pub message: Option<String>,
    pub output_file_path: Option<String>,
}

pub struct ActiveJob {
    pub cancel_flag: Arc<AtomicBool>,
    pub temp_file: Option<PathBuf>,
}
pub fn atomic_replace(temp_path: &Path, target_path: &Path) -> std::io::Result<()> {
    if target_path.exists() {
        let backup_path = target_path.with_extension(format!("bak_{}", uuid::Uuid::new_v4()));
        std::fs::rename(target_path, &backup_path)?;
        if let Err(e) = std::fs::rename(temp_path, target_path) {
            let _ = std::fs::rename(&backup_path, target_path);
            return Err(e);
        }
        let _ = std::fs::remove_file(&backup_path);
        Ok(())
    } else {
        std::fs::rename(temp_path, target_path)
    }
}

fn spawn_stderr_reader(
    stderr_opt: Option<std::process::ChildStderr>,
) -> (Arc<Mutex<Vec<u8>>>, std::thread::JoinHandle<()>) {
    use std::io::Read;
    let buffer = Arc::new(Mutex::new(Vec::<u8>::new()));
    let buffer_clone = Arc::clone(&buffer);

    let handle = std::thread::spawn(move || {
        if let Some(mut stream) = stderr_opt {
            let mut chunk = [0u8; 1024];
            while let Ok(n) = stream.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let mut cap = buffer_clone.lock();
                cap.extend_from_slice(&chunk[..n]);
                if cap.len() > 65536 {
                    let excess = cap.len() - 65536;
                    cap.drain(0..excess);
                }
            }
        }
    });

    (buffer, handle)
}
pub struct ThumbnailPermitPool {
    active: Mutex<usize>,
    cond: parking_lot::Condvar,
}

impl ThumbnailPermitPool {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(0),
            cond: parking_lot::Condvar::new(),
        }
    }
}

struct PermitGuard<'a>(&'a ThumbnailPermitPool);
impl<'a> Drop for PermitGuard<'a> {
    fn drop(&mut self) {
        let mut count = self.0.active.lock();
        *count = count.saturating_sub(1);
        self.0.cond.notify_one();
    }
}


pub struct MediaProcessor {
    app_data_dir: PathBuf,
    thumbnails_dir: PathBuf,
    proxies_dir: PathBuf,
    editor_assets_dir: PathBuf,
    tools_dir: Mutex<Option<PathBuf>>,
    active_jobs: Arc<Mutex<HashMap<String, ActiveJob>>>,
    permit_pool: ThumbnailPermitPool,
}

impl MediaProcessor {
    pub fn new(app_data_dir: &Path) -> Result<Arc<Self>, AppError> {
        let thumbnails_dir = app_data_dir.join("thumbnails");
        let proxies_dir = app_data_dir.join("proxies");
        let editor_assets_dir = app_data_dir.join("editor_assets");

        std::fs::create_dir_all(&thumbnails_dir)?;
        std::fs::create_dir_all(&proxies_dir)?;
        std::fs::create_dir_all(&editor_assets_dir)?;

        Ok(Arc::new(Self {
            app_data_dir: app_data_dir.to_path_buf(),
            thumbnails_dir,
            proxies_dir,
            editor_assets_dir,
            tools_dir: Mutex::new(None),
            active_jobs: Arc::new(Mutex::new(HashMap::new())),
            permit_pool: ThumbnailPermitPool::new(),
        }))
    }

    pub fn set_tools_dir(&self, path: Option<PathBuf>) {
        *self.tools_dir.lock() = path;
    }

    pub fn app_data_dir(&self) -> &Path {
        &self.app_data_dir
    }

    pub fn thumbnails_dir(&self) -> &Path {
        &self.thumbnails_dir
    }

    pub fn proxies_dir(&self) -> &Path {
        &self.proxies_dir
    }

    pub fn editor_assets_dir(&self) -> &Path {
        &self.editor_assets_dir
    }

    // Resolving ffmpeg / ffprobe
    pub fn resolve_binary(&self, name: &str) -> Option<PathBuf> {
        let exe_name = if cfg!(windows) {
            format!("{}.exe", name)
        } else {
            name.to_string()
        };

        // 1. Packaged sibling in current executable dir
        if let Ok(current_exe) = std::env::current_exe() {
            if let Some(parent) = current_exe.parent() {
                let candidate = parent.join(&exe_name);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }

        // 2. User-selected tools dir
        if let Some(tools_dir) = self.tools_dir.lock().as_ref() {
            let candidate = tools_dir.join(&exe_name);
            if candidate.exists() {
                return Some(candidate);
            }
        }

        // 3. System PATH
        if let Ok(path_var) = std::env::var("PATH") {
            for dir in std::env::split_paths(&path_var) {
                let candidate = dir.join(&exe_name);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }

        None
    }

    pub fn get_system_info(&self) -> SystemInfo {
        let ffmpeg_bin = self.resolve_binary("ffmpeg");
        let ffprobe_bin = self.resolve_binary("ffprobe");

        let (ffmpeg_avail, ffmpeg_ver) = match &ffmpeg_bin {
            Some(path) => {
                let ver = Command::new(path)
                    .arg("-version")
                    .output()
                    .ok()
                    .and_then(|out| {
                        let text = String::from_utf8_lossy(&out.stdout).to_string();
                        text.lines().next().map(|l| l.to_string())
                    });
                (ver.is_some(), ver)
            }
            None => (false, None),
        };

        let (ffprobe_avail, ffprobe_ver) = match &ffprobe_bin {
            Some(path) => {
                let ver = Command::new(path)
                    .arg("-version")
                    .output()
                    .ok()
                    .and_then(|out| {
                        let text = String::from_utf8_lossy(&out.stdout).to_string();
                        text.lines().next().map(|l| l.to_string())
                    });
                (ver.is_some(), ver)
            }
            None => (false, None),
        };

        SystemInfo {
            ffmpeg_available: ffmpeg_avail,
            ffmpeg_version: ffmpeg_ver,
            ffprobe_available: ffprobe_avail,
            ffprobe_version: ffprobe_ver,
            resolved_ffmpeg_path: ffmpeg_bin.map(|p| p.to_string_lossy().to_string()),
            resolved_ffprobe_path: ffprobe_bin.map(|p| p.to_string_lossy().to_string()),
            app_data_dir: self.app_data_dir.to_string_lossy().to_string(),
        }
    }
    pub fn compute_file_hash(&self, path: &Path) -> Result<String, AppError> {
        use sha2::{Digest, Sha256};
        let mut file = std::fs::File::open(path)?;
        let mut hasher = Sha256::new();
        std::io::copy(&mut file, &mut hasher)?;
        let result = hasher.finalize();
        Ok(format!("{:x}", result))
    }


    pub fn probe_media(
        &self,
        path: &Path,
        kind: &str,
    ) -> Result<(Option<i32>, Option<i32>, Option<i64>), AppError> {
        if kind == "image" {
            if let Ok((w, h)) = image::image_dimensions(path) {
                return Ok((Some(w as i32), Some(h as i32), None));
            }
        }

        let ffprobe = self.resolve_binary("ffprobe").ok_or_else(|| {
            AppError::new("FFPROBE_MISSING", "FFprobe executable not found on system")
        })?;

        let output = Command::new(ffprobe)
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height,duration",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
            ])
            .arg(path)
            .output()
            .map_err(|e| AppError::with_details("PROBE_FAILED", "Failed to run ffprobe", e.to_string()))?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::with_details("PROBE_FAILED", "FFprobe returned error status", err.to_string()));
        }

        let text = String::from_utf8_lossy(&output.stdout);
        let val: serde_json::Value = serde_json::from_str(&text)?;

        let mut width = None;
        let mut height = None;
        let mut duration_ms = None;

        if let Some(streams) = val.get("streams").and_then(|s| s.as_array()) {
            if let Some(stream) = streams.first() {
                width = stream.get("width").and_then(|w| w.as_i64()).map(|w| w as i32);
                height = stream.get("height").and_then(|h| h.as_i64()).map(|h| h as i32);
                if let Some(d_str) = stream.get("duration").and_then(|d| d.as_str()) {
                    if let Ok(d_sec) = d_str.parse::<f64>() {
                        duration_ms = Some((d_sec * 1000.0).round() as i64);
                    }
                }
            }
        }

        if duration_ms.is_none() {
            if let Some(format) = val.get("format") {
                if let Some(d_str) = format.get("duration").and_then(|d| d.as_str()) {
                    if let Ok(d_sec) = d_str.parse::<f64>() {
                        duration_ms = Some((d_sec * 1000.0).round() as i64);
                    }
                }
            }
        }

        Ok((width, height, duration_ms))
    }

    pub fn get_or_generate_thumbnail(
        &self,
        media_id: &str,
        path: &Path,
        kind: &str,
        size_bytes: i64,
        modified_ms: i64,
    ) -> Result<PathBuf, AppError> {
        let thumb_filename = format!("{}_{}_{}.jpg", media_id, size_bytes, modified_ms);
        let thumb_path = self.thumbnails_dir.join(&thumb_filename);

        if thumb_path.exists() {
            return Ok(thumb_path);
        }

        // Enforce maximum 2 concurrent derivative jobs
        {
            let mut count = self.permit_pool.active.lock();
            while *count >= 2 {
                self.permit_pool.cond.wait(&mut count);
            }
            *count += 1;
        }
        let _guard = PermitGuard(&self.permit_pool);

        let temp_thumb = self.thumbnails_dir.join(format!("{}.tmp.jpg", uuid::Uuid::new_v4()));

        if kind == "image" {
            if let Ok(img) = image::open(path) {
                let thumb = img.thumbnail(400, 300);
                thumb
                    .save_with_format(&temp_thumb, image::ImageFormat::Jpeg)
                    .map_err(|e| AppError::with_details("THUMB_ERROR", "Failed to save thumbnail", e.to_string()))?;
                atomic_replace(&temp_thumb, &thumb_path)?;
                return Ok(thumb_path);
            }
        }

        let ffmpeg = self.resolve_binary("ffmpeg").ok_or_else(|| {
            AppError::new("FFMPEG_MISSING", "FFmpeg executable not found for thumbnail generation")
        })?;

        let mut cmd = Command::new(&ffmpeg);
        cmd.args(["-y", "-ss", "00:00:01", "-i"])
            .arg(path)
            .args(["-vframes", "1", "-vf", "scale=w='min(400,iw)':h=-1", "-q:v", "3"])
            .arg(&temp_thumb);

        let res = cmd.output();
        let success = match res {
            Ok(output) if output.status.success() => true,
            _ => false,
        };

        if !success {
            let mut retry_cmd = Command::new(&ffmpeg);
            retry_cmd
                .args(["-y", "-ss", "00:00:00", "-i"])
                .arg(path)
                .args(["-vframes", "1", "-vf", "scale=w='min(400,iw)':h=-1", "-q:v", "3"])
                .arg(&temp_thumb);

            let retry_res = retry_cmd.output().map_err(|e| {
                AppError::with_details("THUMB_ERROR", "Failed to execute ffmpeg for thumbnail", e.to_string())
            })?;

            if !retry_res.status.success() {
                let _ = std::fs::remove_file(&temp_thumb);
                let err_msg = String::from_utf8_lossy(&retry_res.stderr);
                return Err(AppError::with_details("THUMB_ERROR", "FFmpeg thumbnail generation failed", err_msg.to_string()));
            }
        }

        atomic_replace(&temp_thumb, &thumb_path)?;
        Ok(thumb_path)
    }

    pub fn get_proxy_path(&self, media_id: &str) -> PathBuf {
        self.proxies_dir.join(format!("{}.mp4", media_id))
    }

    pub fn generate_proxy(
        &self,
        app: AppHandle,
        job_id: &str,
        media_id: &str,
        input_path: &Path,
    ) -> Result<String, AppError> {
        let proxy_path = self.get_proxy_path(media_id);
        if proxy_path.exists() {
            let _ = app.emit(
                "jkc://job-progress",
                JobProgressEvent {
                    job_id: job_id.to_string(),
                    job_type: "proxy".to_string(),
                    target_id: media_id.to_string(),
                    status: "completed".to_string(),
                    progress: 1.0,
                    message: Some("Proxy already exists".to_string()),
                    output_file_path: Some(proxy_path.to_string_lossy().to_string()),
                },
            );
            return Ok(proxy_path.to_string_lossy().to_string());
        }

        let ffmpeg = self.resolve_binary("ffmpeg").ok_or_else(|| {
            AppError::new("FFMPEG_MISSING", "FFmpeg executable not found for proxy generation")
        })?;

        let temp_proxy = self.proxies_dir.join(format!("{}_{}.tmp.mp4", media_id, uuid::Uuid::new_v4()));

        let cancel_flag = Arc::new(AtomicBool::new(false));
        let active_jobs = Arc::clone(&self.active_jobs);

        {
            let mut jobs = active_jobs.lock();
            jobs.insert(
                job_id.to_string(),
                ActiveJob {
                    cancel_flag: Arc::clone(&cancel_flag),
                    temp_file: Some(temp_proxy.clone()),
                },
            );
        }

        let mut cmd = Command::new(&ffmpeg);
        cmd.args(["-y", "-i"])
            .arg(input_path)
            .args([
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
            ])
            .arg(&temp_proxy)
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            active_jobs.lock().remove(job_id);
            AppError::with_details("SPAWN_ERROR", "Failed to spawn proxy conversion process", e.to_string())
        })?;

        let stderr_stream = child.stderr.take();
        let (stderr_buf, stderr_handle) = spawn_stderr_reader(stderr_stream);

        let _ = app.emit(
            "jkc://job-progress",
            JobProgressEvent {
                job_id: job_id.to_string(),
                job_type: "proxy".to_string(),
                target_id: media_id.to_string(),
                status: "running".to_string(),
                progress: 0.1,
                message: Some("Generating H.264 preview proxy...".to_string()),
                output_file_path: None,
            },
        );

        let jid = job_id.to_string();
        let mid = media_id.to_string();

        std::thread::spawn(move || {
            let mut status_opt = None;

            loop {
                if cancel_flag.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stderr_handle.join();
                    let _ = std::fs::remove_file(&temp_proxy);
                    active_jobs.lock().remove(&jid);
                    let _ = app.emit(
                        "jkc://job-progress",
                        JobProgressEvent {
                            job_id: jid,
                            job_type: "proxy".to_string(),
                            target_id: mid,
                            status: "cancelled".to_string(),
                            progress: 0.0,
                            message: Some("Proxy generation cancelled".to_string()),
                            output_file_path: None,
                        },
                    );
                    return;
                }

                match child.try_wait() {
                    Ok(Some(status)) => {
                        status_opt = Some(status);
                        break;
                    }
                    Ok(None) => {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    Err(_) => break,
                }
            }

            active_jobs.lock().remove(&jid);
            let _ = stderr_handle.join();

            if let Some(status) = status_opt {
                if status.success() {
                    let replace_res = atomic_replace(&temp_proxy, &proxy_path);
                    if let Err(e) = replace_res {
                        let _ = std::fs::remove_file(&temp_proxy);
                        let _ = app.emit(
                            "jkc://job-progress",
                            JobProgressEvent {
                                job_id: jid,
                                job_type: "proxy".to_string(),
                                target_id: mid,
                                status: "failed".to_string(),
                                progress: 0.0,
                                message: Some(format!("Failed to finalize proxy file: {}", e)),
                                output_file_path: None,
                            },
                        );
                        return;
                    }
                    let _ = app.emit(
                        "jkc://job-progress",
                        JobProgressEvent {
                            job_id: jid,
                            job_type: "proxy".to_string(),
                            target_id: mid,
                            status: "completed".to_string(),
                            progress: 1.0,
                            message: Some("Proxy generated successfully".to_string()),
                            output_file_path: Some(proxy_path.to_string_lossy().to_string()),
                        },
                    );
                } else {
                    let _ = std::fs::remove_file(&temp_proxy);
                    let err_msg = String::from_utf8_lossy(&stderr_buf.lock()).to_string();
                    let _ = app.emit(
                        "jkc://job-progress",
                        JobProgressEvent {
                            job_id: jid,
                            job_type: "proxy".to_string(),
                            target_id: mid,
                            status: "failed".to_string(),
                            progress: 0.0,
                            message: Some(format!("FFmpeg failed to create proxy: {}", err_msg)),
                            output_file_path: None,
                        },
                    );
                }
            } else {
                let _ = std::fs::remove_file(&temp_proxy);
            }
        });

        Ok(job_id.to_string())
    }

    pub fn capture_still(
        &self,
        input_path: &Path,
        time_ms: i64,
        target_path: &Path,
    ) -> Result<(), AppError> {
        if let (Ok(in_c), Ok(out_c)) = (input_path.canonicalize(), target_path.canonicalize()) {
            if in_c == out_c {
                return Err(AppError::new("INVALID_DESTINATION", "Destination matches source file"));
            }
        } else if input_path == target_path {
            return Err(AppError::new("INVALID_DESTINATION", "Destination matches source file"));
        }

        let ffmpeg = self.resolve_binary("ffmpeg").ok_or_else(|| {
            AppError::new("FFMPEG_MISSING", "FFmpeg executable not found for still capture")
        })?;

        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let temp_still = target_path.with_extension(format!("tmp_{}.png", uuid::Uuid::new_v4()));
        let time_sec = format!("{:.3}", time_ms as f64 / 1000.0);

        let mut cmd = Command::new(ffmpeg);
        cmd.args(["-y", "-ss", &time_sec, "-i"])
            .arg(input_path)
            .args(["-vframes", "1"])
            .arg(&temp_still);

        let output = cmd.output().map_err(|e| {
            AppError::with_details("CAPTURE_FAILED", "Failed to run ffmpeg still capture", e.to_string())
        })?;

        if !output.status.success() {
            let _ = std::fs::remove_file(&temp_still);
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::with_details("CAPTURE_FAILED", "FFmpeg still capture failed", err.to_string()));
        }

        atomic_replace(&temp_still, target_path)?;
        Ok(())
    }

    pub fn detect_shots(
        &self,
        input_path: &Path,
        duration_ms: i64,
    ) -> Result<Vec<i64>, AppError> {
        let ffmpeg = self.resolve_binary("ffmpeg").ok_or_else(|| {
            AppError::new("FFMPEG_MISSING", "FFmpeg executable not found for shot detection")
        })?;

        let mut cmd = Command::new(ffmpeg);
        cmd.args(["-i"])
            .arg(input_path)
            .args(["-filter_complex", "select='gt(scene,0.30)',showinfo", "-f", "null", "-"]);

        let output = cmd.output().map_err(|e| {
            AppError::with_details("SHOT_DETECT_FAILED", "Failed to execute ffmpeg for shot detection", e.to_string())
        })?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            let detail = if err.len() > 1024 {
                &err[err.len() - 1024..]
            } else {
                &err
            };
            return Err(AppError::with_details(
                "SHOT_DETECT_FAILED",
                "FFmpeg shot detection failed",
                detail.to_string(),
            ));
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        let re = Regex::new(r"pts_time:([0-9]+(?:\.[0-9]+)?)").unwrap();

        let mut boundaries = vec![0i64];

        for cap in re.captures_iter(&stderr) {
            if let Some(m) = cap.get(1) {
                if let Ok(sec) = m.as_str().parse::<f64>() {
                    let ms = (sec * 1000.0).round() as i64;
                    if ms > 0 && ms < duration_ms {
                        boundaries.push(ms);
                    }
                }
            }
        }

        boundaries.sort_unstable();
        boundaries.dedup();

        if let Some(&last) = boundaries.last() {
            if last < duration_ms {
                boundaries.push(duration_ms);
            }
        } else {
            boundaries.push(duration_ms);
        }

        Ok(boundaries)
    }

    pub fn export_take(
        &self,
        app: AppHandle,
        job_id: &str,
        media_id: &str,
        input_path: &Path,
        in_ms: i64,
        out_ms: i64,
        format: &str,
        target_path: &Path,
    ) -> Result<String, AppError> {
        // Validation: reject destination matching source
        if let (Ok(in_canon), Ok(out_canon)) = (input_path.canonicalize(), target_path.canonicalize()) {
            if in_canon == out_canon {
                return Err(AppError::new("INVALID_DESTINATION", "Export target cannot be the source file"));
            }
        } else if input_path == target_path {
            return Err(AppError::new("INVALID_DESTINATION", "Export target cannot be the source file"));
        }

        if out_ms <= in_ms {
            return Err(AppError::new("INVALID_RANGE", "Take out-point must be greater than in-point"));
        }

        let ffmpeg = self.resolve_binary("ffmpeg").ok_or_else(|| {
            AppError::new("FFMPEG_MISSING", "FFmpeg executable not found for export")
        })?;

        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let ext = if format == "gif" { "gif" } else { "mp4" };
        let temp_target = target_path.with_extension(format!("tmp_{}.{}", uuid::Uuid::new_v4(), ext));

        let cancel_flag = Arc::new(AtomicBool::new(false));
        let active_jobs = Arc::clone(&self.active_jobs);

        {
            let mut jobs = active_jobs.lock();
            jobs.insert(
                job_id.to_string(),
                ActiveJob {
                    cancel_flag: Arc::clone(&cancel_flag),
                    temp_file: Some(temp_target.clone()),
                },
            );
        }

        let in_sec = format!("{:.3}", in_ms as f64 / 1000.0);
        let out_sec = format!("{:.3}", out_ms as f64 / 1000.0);

        let mut cmd = Command::new(&ffmpeg);

        if format == "gif" {
            cmd.args(["-y", "-ss", &in_sec, "-to", &out_sec, "-i"])
                .arg(input_path)
                .args([
                    "-filter_complex",
                    "[0:v] fps=12,scale=w='min(640,iw)':h=-1:flags=lanczos,split [a][b];[a] palettegen [p];[b][p] paletteuse",
                ])
                .arg(&temp_target);
        } else {
            cmd.args(["-y", "-ss", &in_sec, "-to", &out_sec, "-i"])
                .arg(input_path)
                .args([
                    "-c:v",
                    "libx264",
                    "-preset",
                    "medium",
                    "-crf",
                    "20",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "192k",
                    "-movflags",
                    "+faststart",
                ])
                .arg(&temp_target);
        }

        cmd.stdout(Stdio::null()).stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            active_jobs.lock().remove(job_id);
            AppError::with_details("SPAWN_ERROR", "Failed to spawn export process", e.to_string())
        })?;

        let stderr_stream = child.stderr.take();
        let (stderr_buf, stderr_handle) = spawn_stderr_reader(stderr_stream);

        let _ = app.emit(
            "jkc://job-progress",
            JobProgressEvent {
                job_id: job_id.to_string(),
                job_type: format!("export_{}", format),
                target_id: media_id.to_string(),
                status: "running".to_string(),
                progress: 0.1,
                message: Some(format!("Exporting take as {}...", format.to_uppercase())),
                output_file_path: None,
            },
        );

        let jid = job_id.to_string();
        let mid = media_id.to_string();
        let dest = target_path.to_path_buf();
        let fmt = format.to_string();

        std::thread::spawn(move || {
            let mut status_opt = None;

            loop {
                if cancel_flag.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stderr_handle.join();
                    let _ = std::fs::remove_file(&temp_target);
                    active_jobs.lock().remove(&jid);
                    let _ = app.emit(
                        "jkc://job-progress",
                        JobProgressEvent {
                            job_id: jid,
                            job_type: format!("export_{}", fmt),
                            target_id: mid,
                            status: "cancelled".to_string(),
                            progress: 0.0,
                            message: Some("Export cancelled".to_string()),
                            output_file_path: None,
                        },
                    );
                    return;
                }

                match child.try_wait() {
                    Ok(Some(status)) => {
                        status_opt = Some(status);
                        break;
                    }
                    Ok(None) => {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    Err(_) => break,
                }
            }

            active_jobs.lock().remove(&jid);
            let _ = stderr_handle.join();

            if let Some(status) = status_opt {
                if status.success() {
                    let rename_res = atomic_replace(&temp_target, &dest);
                    if let Err(e) = rename_res {
                        let _ = std::fs::remove_file(&temp_target);
                        let _ = app.emit(
                            "jkc://job-progress",
                            JobProgressEvent {
                                job_id: jid,
                                job_type: format!("export_{}", fmt),
                                target_id: mid,
                                status: "failed".to_string(),
                                progress: 0.0,
                                message: Some(format!("Failed to finalize export file: {}", e)),
                                output_file_path: None,
                            },
                        );
                        return;
                    }

                    let _ = app.emit(
                        "jkc://job-progress",
                        JobProgressEvent {
                            job_id: jid,
                            job_type: format!("export_{}", fmt),
                            target_id: mid,
                            status: "completed".to_string(),
                            progress: 1.0,
                            message: Some("Export completed successfully".to_string()),
                            output_file_path: Some(dest.to_string_lossy().to_string()),
                        },
                    );
                } else {
                    let _ = std::fs::remove_file(&temp_target);
                    let err_msg = String::from_utf8_lossy(&stderr_buf.lock()).to_string();
                    let _ = app.emit(
                        "jkc://job-progress",
                        JobProgressEvent {
                            job_id: jid,
                            job_type: format!("export_{}", fmt),
                            target_id: mid,
                            status: "failed".to_string(),
                            progress: 0.0,
                            message: Some(format!("FFmpeg export error: {}", err_msg)),
                            output_file_path: None,
                        },
                    );
                }
            } else {
                let _ = std::fs::remove_file(&temp_target);
            }
        });

        Ok(job_id.to_string())
    }

    pub fn cancel_job(&self, job_id: &str) -> Result<(), AppError> {
        let jobs = self.active_jobs.lock();
        if let Some(job) = jobs.get(job_id) {
            job.cancel_flag.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
}
