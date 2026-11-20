#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use tokio::io::{AsyncBufReadExt, BufReader};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

#[derive(Serialize)]
struct MediaToolsStatus {
    ffmpeg: bool,
    ffprobe: bool,
    yt_dlp: bool,
}

#[derive(Serialize)]
struct AnalyzedSource {
    video_id: String,
    kind: String,
    canonical_url: String,
    title: String,
    thumbnail: Option<String>,
    duration: Option<f64>,
    uploader: Option<String>,
    formats: Vec<VideoQuality>,
}

#[derive(Serialize)]
struct VideoQuality {
    height: u32,
    label: String,
    fps: Option<f64>,
}

#[derive(Deserialize)]
struct YtDlpInfo {
    #[serde(default)]
    title: String,
    thumbnail: Option<String>,
    duration: Option<f64>,
    uploader: Option<String>,
    #[serde(default)]
    formats: Vec<YtDlpFormat>,
}

#[derive(Deserialize)]
struct YtDlpFormat {
    height: Option<u32>,
    ext: Option<String>,
    vcodec: Option<String>,
    acodec: Option<String>,
    fps: Option<f64>,
}

fn resolve_tool(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let resource_path = format!("binaries/{name}.exe");

    if let Ok(path) = app.path().resolve(resource_path, BaseDirectory::Resource) {
        if path.is_file() {
            return Some(path);
        }
    }

    which::which(name).ok()
}

#[tauri::command]
async fn check_media_tools(app: AppHandle) -> MediaToolsStatus {
    MediaToolsStatus {
        ffmpeg: resolve_tool(&app, "ffmpeg").is_some(),
        ffprobe: resolve_tool(&app, "ffprobe").is_some(),
        yt_dlp: resolve_tool(&app, "yt-dlp").is_some(),
    }
}

#[tauri::command]
async fn analyze_source(app: AppHandle, url: String) -> Result<AnalyzedSource, String> {
    let parsed = Url::parse(&url)
        .map_err(|_| "Please enter a valid URL.".to_string())?;

    let host = parsed.host_str()
        .unwrap_or_default()
        .to_ascii_lowercase();

    let allowed_host = matches!(
        host.as_str(),
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "youtu.be"
    );

    if parsed.scheme() != "https" || !allowed_host {
        return Err("Please use an HTTPS YouTube video or Shorts URL.".into());
    }

    let (video_id, kind) = if host == "youtu.be" {
        let id = parsed.path_segments()
            .and_then(|mut parts| parts.next())
            .filter(|s| valid_video_id(s))
            .ok_or_else(|| "That youtu.be URL does not contain a valid video ID.".to_string())?;

        (id.to_string(), "video")
    } else if let Some(id) = parsed.query_pairs()
        .find(|(key, _)| key == "v")
        .map(|(_, value)| value.to_string())
        .filter(|id| valid_video_id(id))
    {
        (id, "video")
    } else if let Some(id) = parsed.path_segments()
        .and_then(|mut parts| {
            let first = parts.next()?;
            if first == "shorts" {
                parts.next()
            } else {
                None
            }
        })
        .filter(|s| valid_video_id(s))
    {
        (id.to_string(), "shorts")
    } else {
        return Err("This URL is not a recognized YouTube video or Shorts link.".into());
    };

    let canonical_url = format!("https://www.youtube.com/watch?v={video_id}");

    let yt_dlp = resolve_tool(&app, "yt-dlp")
        .ok_or_else(|| "yt-dlp could not be found.".to_string())?;

    let mut command = Command::new(yt_dlp);
    command
        .args([
            "--dump-single-json",
            "--no-warnings",
            "--skip-download",
            "--no-playlist",
        ])
        .arg(&canonical_url)
        .kill_on_drop(true);

    let output = tokio::time::timeout(
        Duration::from_secs(120),
        command.output(),
    )
    .await
    .map_err(|_| "Analysis timed out. Please try again.".to_string())?
    .map_err(|error| {
        format!("Could not start yt-dlp. Details: {error}")
    })?;

    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        let details: String = error.trim().chars().take(500).collect();

        return Err(if details.is_empty() {
            "yt-dlp could not analyze this video. It may be unavailable or unsupported.".into()
        } else {
            format!("yt-dlp could not analyze this video: {details}")
        });
    }

    let info: YtDlpInfo = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Could not read video information: {error}"))?;

    if info.title.is_empty() {
        return Err("The video did not provide a usable title.".into());
    }

    // Keep one representative format per resolution.
    // Prefer MP4, H.264, and formats that already include audio.
    let mut qualities: BTreeMap<u32, (u8, VideoQuality)> = BTreeMap::new();

    for format in info.formats {
        let height = match format.height {
            Some(height) if height > 0 => height,
            _ => continue,
        };

        let vcodec = format.vcodec.as_deref().unwrap_or("none");
        if vcodec == "none" {
            continue;
        }

        let ext = format.ext.as_deref().unwrap_or("");
        if !matches!(ext, "mp4" | "webm" | "mkv") {
            continue;
        }

        let has_audio = format.acodec.as_deref()
            .is_some_and(|codec| codec != "none");

        let is_h264 = vcodec.starts_with("avc1");
        let is_mp4 = ext == "mp4";

        let score =
            u8::from(is_mp4) * 4
            + u8::from(is_h264) * 2
            + u8::from(has_audio);

        let quality = VideoQuality {
            height,
            label: format!("{height}p"),
            fps: format.fps,
        };

        let replace = qualities
            .get(&height)
            .is_none_or(|(existing_score, _)| score > *existing_score);

        if replace {
            qualities.insert(height, (score, quality));
        }
    }

    let formats = qualities
        .into_values()
        .map(|(_, quality)| quality)
        .rev()
        .collect::<Vec<_>>();

    if formats.is_empty() {
        return Err("No compatible video formats were found for this source.".into());
    }

    Ok(AnalyzedSource {
        video_id,
        kind: kind.to_string(),
        canonical_url,
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        uploader: info.uploader,
        formats,
    })
}


#[derive(Clone, Serialize)]
struct DownloadProgress {
    percent: f64,
    speed: String,
    eta: String,
    status: String,
}

#[tauri::command]
async fn download_media(
    app: AppHandle,
    url: String,
    output_dir: String,
    format: String,
    height: u32,
) -> Result<String, String> {
    // Only allow HTTPS YouTube video URLs.
    let parsed = Url::parse(&url)
        .map_err(|_| "Invalid video URL.".to_string())?;

    let host = parsed.host_str()
        .unwrap_or_default()
        .to_ascii_lowercase();

    if parsed.scheme() != "https"
        || !matches!(
            host.as_str(),
            "youtube.com" | "www.youtube.com" | "m.youtube.com" | "youtu.be"
        )
    {
        return Err("Only HTTPS YouTube video URLs are supported.".into());
    }

    let video_id = if host == "youtu.be" {
        parsed.path_segments()
            .and_then(|mut parts| parts.next())
            .map(str::to_string)
    } else {
        parsed.query_pairs()
            .find(|(key, _)| key == "v")
            .map(|(_, value)| value.to_string())
    };

    if !video_id.as_deref().is_some_and(valid_video_id) {
        return Err("The URL does not contain a valid YouTube video ID.".into());
    }

    if !matches!(format.as_str(), "mp4" | "mp3") {
        return Err("Unsupported output format.".into());
    }

    if format == "mp4" && !(144..=4320).contains(&height) {
        return Err("Please select a valid video resolution.".into());
    }

    let parent = PathBuf::from(output_dir);
    if !parent.is_dir() {
        return Err("The selected save folder does not exist.".into());
    }

    let media_root = parent.join("Downloaded Media");
    let videos_dir = media_root.join("Videos");
    let audios_dir = media_root.join("Audios");

    std::fs::create_dir_all(&videos_dir)
        .map_err(|error| format!("Could not create Videos folder: {error}"))?;
    std::fs::create_dir_all(&audios_dir)
        .map_err(|error| format!("Could not create Audios folder: {error}"))?;

    let destination = if format == "mp4" {
        videos_dir
    } else {
        audios_dir
    };

    let yt_dlp = resolve_tool(&app, "yt-dlp")
        .ok_or_else(|| "yt-dlp could not be found.".to_string())?;

    let ffmpeg = resolve_tool(&app, "ffmpeg")
        .ok_or_else(|| "FFmpeg is required but could not be found.".to_string())?;

    let ffmpeg_dir = ffmpeg
        .parent()
        .ok_or_else(|| "Could not determine the FFmpeg directory.".to_string())?
        .to_path_buf();

    let mut command = Command::new(yt_dlp);
    command.arg("--ffmpeg-location").arg(ffmpeg_dir);

    command
        .arg("--no-playlist")
        .arg("--newline")
        .arg("--no-warnings")
        .arg("--concurrent-fragments")
        .arg("8")
        .arg("--progress-template")
        .arg("download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s")
        .arg("--paths")
        .arg(&destination)
        .arg("--output")
        .arg("%(title).200B [%(id)s].%(ext)s");

    if format == "mp4" {
        command
            .arg("--format")
            .arg(format!(
                "bestvideo[height<={height}]+bestaudio/best[height<={height}]"
            ))
            .arg("--merge-output-format")
            .arg("mp4");
    } else {
        command
            .arg("--format")
            .arg("bestaudio/best")
            .arg("--extract-audio")
            .arg("--audio-format")
            .arg("mp3")
            .arg("--audio-quality")
            .arg("0");
    }

    command
        .arg(&url)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command.spawn()
        .map_err(|error| format!("Could not start yt-dlp: {error}"))?;

    let stderr = child.stderr.take()
        .ok_or_else(|| "Could not read download progress.".to_string())?;

    let _ = app.emit("download-progress", DownloadProgress {
        percent: 0.0,
        speed: "Starting…".into(),
        eta: String::new(),
        status: "Preparing download".into(),
    });

    let mut reader = BufReader::new(stderr).lines();
    let mut error_lines: Vec<String> = Vec::new();

    while let Some(line) = reader.next_line().await
        .map_err(|error| format!("Could not read download output: {error}"))?
    {
        if line.contains('|') {
            let parts: Vec<&str> = line.splitn(3, '|').collect();

            if parts.len() == 3 {
                let percent_text = parts[0]
                    .split_whitespace()
                    .find(|part| part.ends_with('%'))
                    .unwrap_or("")
                    .trim_end_matches('%');

                if let Ok(percent) = percent_text.trim().parse::<f64>() {
                    let _ = app.emit("download-progress", DownloadProgress {
                        percent: percent.clamp(0.0, 100.0),
                        speed: parts[1].trim().to_string(),
                        eta: parts[2].trim().to_string(),
                        status: "Downloading".into(),
                    });
                }
            }
        }

        if line.contains("ERROR:") {
            error_lines.push(line.trim().to_string());
            if error_lines.len() > 8 {
                error_lines.remove(0);
            }
        }
    }

    let status = child.wait().await
        .map_err(|error| format!("Could not finish download process: {error}"))?;

    if !status.success() {
        let details = error_lines.join("\n");
        return Err(if details.is_empty() {
            format!("yt-dlp exited with status: {status}")
        } else {
            details
        });
    }

    let _ = app.emit("download-progress", DownloadProgress {
        percent: 100.0,
        speed: String::new(),
        eta: String::new(),
        status: "Download complete".into(),
    });

    Ok("Download completed successfully.".into())
}

fn valid_video_id(value: &str) -> bool {
    (6..=20).contains(&value.len())
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[allow(dead_code)]
async fn probe_local_file(app: &AppHandle, path: &Path) -> Result<String, String> {
    if !path.is_file() {
        return Err("Input file does not exist.".into());
    }

    let ffprobe = resolve_tool(app, "ffprobe")
        .ok_or_else(|| "FFprobe could not be found.".to_string())?;

    let output = tokio::process::Command::new(ffprobe)
        .args(["-v", "error", "-show_format", "-of", "json"])
        .arg(path)
        .output()
        .await
        .map_err(|e| format!("Could not start FFprobe: {e}"))?;

    if !output.status.success() {
        return Err("FFprobe could not read this file.".into());
    }

    String::from_utf8(output.stdout)
        .map_err(|_| "FFprobe returned invalid UTF-8.".into())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            check_media_tools,
            analyze_source,
            download_media
        ])
        .run(tauri::generate_context!())
        .expect("error while running Media Downloader");
}

#[cfg(test)]
mod tests {
    use super::valid_video_id;

    #[test]
    fn accepts_typical_video_ids() {
        assert!(valid_video_id("dQw4w9WgXcQ"));
        assert!(valid_video_id("abc_DEF-123"));
    }

    #[test]
    fn rejects_invalid_video_ids() {
        assert!(!valid_video_id("bad/id"));
        assert!(!valid_video_id("x"));
        assert!(!valid_video_id("this id has spaces"));
    }
}
