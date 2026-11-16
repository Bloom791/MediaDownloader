# Media Downloader — Desktop Starter

A Windows-first desktop application scaffold built with **Tauri 2 + Rust + Tokio + FFmpeg**.
The UI is local HTML/CSS/JavaScript; it does not run as a hosted website.

## Important media-source note

This starter intentionally does **not** include a YouTube extractor or claim to download YouTube media.
The `analyze_source` command validates supported YouTube URL shapes and returns a clear "media source not configured" error. Connect an authorized media provider/source adapter before enabling acquisition. It must respect platform terms, copyright, authentication, and technical access controls.

FFmpeg is used only for local media processing in this starter. It does not bypass source restrictions.

## Requirements (Windows)

1. Install Rust using rustup.
2. Install **Visual Studio Build Tools** with the *Desktop development with C++* workload.
3. Install the Rust MSVC target if needed:
   ```powershell
   rustup default stable-x86_64-pc-windows-msvc
   ```
4. Install Node.js LTS (needed by Tauri's frontend tooling).
5. Install FFmpeg and FFprobe and add their `bin` directory to `PATH`.
6. Install the WebView2 Runtime (normally already present on current Windows 10/11 systems).

> MinGW/Git Bash is fine for Git, but Tauri's Windows build should use the MSVC toolchain.

## Run

From this directory:

```powershell
npm install
npm run tauri dev
```

Build a Windows release:

```powershell
npm run tauri build
```

The installer/bundle output is placed under `src-tauri/target/release/bundle/` (exact format depends on Tauri bundle configuration).

## Project layout

- `src/` — local desktop frontend
- `src-tauri/src/` — Rust commands and application logic
- `src-tauri/tauri.conf.json` — Tauri configuration

## Current milestone

- [x] Tauri desktop shell
- [x] URL-shape validation, including Shorts
- [x] Native FFmpeg/FFprobe availability check
- [x] Safe local FFmpeg argument construction example
- [ ] Authorized source adapter and real format discovery
- [ ] Real processing jobs, cancellation, and progress
- [ ] Download history and native save dialog
- [ ] Installer testing on a clean Windows machine

No feature should be described as working until it has been implemented and tested.
