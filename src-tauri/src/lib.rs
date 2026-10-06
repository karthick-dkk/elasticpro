//! Tauri shell: one command, `bridge`, that forwards the UI's JSON messages to the core.
//! Everything of substance — TLS decisions, SSH tunnels, the read-only guard — lives in
//! `elasticpro-core`, which is exercised by the same tests as the development bridge.

use elasticpro_core::auth::Edition;
use elasticpro_core::Core;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;

#[tauri::command]
async fn bridge(core: tauri::State<'_, Arc<Core>>, msg: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(core.handle(msg).await)
}

/// The folder the exe lives in.
fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf))
}

/// A folder containing `msedgewebview2.exe` at `dir` or one level below it — the
/// layout you get from `expand`ing Microsoft's Fixed Version Runtime .cab.
fn webview2_runtime_in(dir: &Path) -> Option<PathBuf> {
    if dir.join("msedgewebview2.exe").is_file() {
        return Some(dir.to_path_buf());
    }
    let entries = std::fs::read_dir(dir).ok()?;
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() && p.join("msedgewebview2.exe").is_file() {
            return Some(p);
        }
    }
    None
}

/// PORTABLE MODE — nothing installed, nothing written outside the app folder.
///
/// * `WebView2Runtime\` next to the exe (Microsoft's Fixed Version Runtime, unpacked) is
///   used instead of a system-wide WebView2 installation. The loader honours
///   `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER`, so no install and no admin rights are needed.
/// * A `portable` marker file (or an existing `data\` folder) next to the exe puts
///   everything the app stores — pins.json, the WebView's own profile (localStorage,
///   console history), the remembered config path — into `data\` beside the exe.
///
/// Returns whether this is a portable layout, and the data dir to use (None = the normal
/// per-user location).
///
/// The two answers are separate on purpose. A portable copy on a read-only folder still
/// falls back to per-user storage, but it is still portable — and portable must never ask
/// anyone to log in. Collapsing the two would turn an unwritable USB stick into a login
/// prompt with no account behind it.
fn portable_setup() -> (bool, Option<PathBuf>) {
    let Some(dir) = exe_dir() else { return (false, None) };

    if std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").is_none() {
        for cand in ["WebView2Runtime", "webview2", "WebView2"] {
            if let Some(rt) = webview2_runtime_in(&dir.join(cand)) {
                std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", &rt);
                break;
            }
        }
    }

    let portable = dir.join("portable").exists() || dir.join("portable.txt").exists() || dir.join("data").is_dir();
    if !portable {
        return (false, None);
    }
    let data = dir.join("data");
    let _ = std::fs::create_dir_all(data.join("webview2"));
    // must be writable, or fall back to the per-user location — still portable either way
    if std::fs::write(data.join(".write-test"), b"").is_err() {
        return (true, None);
    }
    let _ = std::fs::remove_file(data.join(".write-test"));
    if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", data.join("webview2"));
    }
    (true, Some(data))
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    // Must run before the WebView is created: the loader reads the env vars at that point.
    let (portable, portable_data) = portable_setup();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            // pins.json — fingerprints only, never a credential.
            // portable: <exe dir>\data ; otherwise %APPDATA%\io.elasticpro.desktop
            let data_dir = portable_data.clone().or_else(|| app.path().app_data_dir().ok());
            if let Some(d) = &data_dir {
                let _ = std::fs::create_dir_all(d);
            }
            // Portable stays as it always was: no accounts, no login, nothing stored
            // about anyone. An installed copy gets accounts and roles.
            let edition = if portable { Edition::Portable } else { Edition::Installed };
            let core = Core::new(data_dir, edition);
            // The fleet cache polls the clusters for every page in this window. Started
            // here, on Tauri's runtime, because the poller spawns tasks and setup itself
            // runs outside one; the pages poll FLEET_STATE {since} in process.
            let poller = core.clone();
            tauri::async_runtime::spawn(async move { poller.start_fleet_poller() });
            app.manage(core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![bridge])
        .run(tauri::generate_context!())
        .expect("error while running ElasticPro");
}
