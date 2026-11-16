#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::Path;
use url::Url;

#[derive(Serialize)]
struct MediaToolsStatus {
    ffmpeg: bool,
    ffprobe: bool,
}

#[derive(Serialize)]
struct RecognizedSource {
    video_id: String,
    kind: String,
    canonical_url: String,
}

#[tauri::command]
async fn check_media_tools() -> MediaToolsStatus {
    MediaToolsStatus {
        ffmpeg: which::which("ffmpeg").is_ok(),
        ffprobe: which::which("ffprobe").is_ok(),
    }
}

/// Validates URL shape only. This is deliberately not a media extractor.
#[tauri::command]
async fn analyze_source(url: String) -> Result<RecognizedSource, String> {
    let parsed = Url::parse(&url).map_err(|_| "Please enter a valid URL.".to_string())?;
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();

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
            if first == "shorts" { parts.next() } else { None }
        })
        .filter(|s| valid_video_id(s))
    {
        (id.to_string(), "shorts")
    } else {
        return Err("This URL is not a recognized YouTube video or Shorts link.".into());
    };

    Ok(RecognizedSource {
        canonical_url: format!("https://www.youtube.com/watch?v={video_id}"),
        video_id,
        kind: kind.to_string(),
    })
}

fn valid_video_id(value: &str) -> bool {
    (6..=20).contains(&value.len())
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Example of safe local FFmpeg invocation: arguments are passed individually,
/// never interpolated into a shell command. Wire this into the job system later.
#[allow(dead_code)]
async fn probe_local_file(path: &Path) -> Result<String, String> {
    if !path.is_file() {
        return Err("Input file does not exist.".into());
    }
    let output = tokio::process::Command::new("ffprobe")
        .args(["-v", "error", "-show_format", "-of", "json"])
        .arg(path)
        .output()
        .await
        .map_err(|e| format!("Could not start FFprobe: {e}"))?;

    if !output.status.success() {
        return Err("FFprobe could not read this file.".into());
    }
    String::from_utf8(output.stdout).map_err(|_| "FFprobe returned invalid UTF-8.".into())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![check_media_tools, analyze_source])
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
