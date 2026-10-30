//! App updates from GitHub Releases (`plugins.updater` in tauri.conf.json).
//! Nothing is downloaded until the user asks: `update_check` only reads
//! `latest.json` (the latest release's, or on the pre-release channel the
//! highest-versioned release's); `update_install` downloads, stops the agents
//! and terminals, installs and restarts. Never offers a lower version than
//! the running one, so leaving the pre-release channel waits for stable to
//! catch up.

use std::sync::Mutex;
use std::time::Duration;

use hive_engine::Engine;
use hive_proto::UpdateChannel;
use hive_store::SettingsFile;
use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::http;
use crate::terminals::Terminals;

/// Where releases are published; the same repository as
/// `plugins.updater.endpoints` in tauri.conf.json.
const REPO: &str = "ChillWoW/hive";
/// Releases read for the pre-release channel, newest first.
const RELEASES_PAGE: usize = 30;
/// How long agents get to exit before the installer takes over.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// Progress is reported at most this often (in bytes).
const PROGRESS_STEP: u64 = 256 * 1024;

/// The update the last check found.
#[derive(Default)]
pub struct Updates(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UpdateProgress {
    Downloading { downloaded: u64, total: Option<u64> },
    /// Downloaded; stopping agents and handing over to the installer.
    Installing,
}

/// The newer release on the `updates.channel` setting, if there is one. Dev
/// builds never update.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    updates: State<'_, Updates>,
    settings: State<'_, SettingsFile>,
) -> Result<Option<UpdateInfo>, String> {
    if cfg!(debug_assertions) {
        return Ok(None);
    }
    let updater = match settings.get().updates.channel {
        // `plugins.updater.endpoints`: GitHub's latest release, which is
        // never a pre-release.
        UpdateChannel::Stable => app.updater(),
        UpdateChannel::Prerelease => {
            let endpoint = newest_release_manifest().await?;
            app.updater_builder()
                .endpoints(vec![endpoint])
                .and_then(|builder| builder.build())
        }
    }
    .map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone().filter(|b| !b.trim().is_empty()),
    });
    *updates.0.lock().unwrap() = update;
    Ok(info)
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    draft: bool,
    assets: Vec<GitHubAsset>,
}

#[derive(Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

/// The `latest.json` of the highest-versioned release, pre-releases
/// included. Only releases that have one count (a build still uploading
/// doesn't yet).
async fn newest_release_manifest() -> Result<Url, String> {
    let request = http::github_get(&format!(
        "https://api.github.com/repos/{REPO}/releases?per_page={RELEASES_PAGE}"
    ))
    .ok_or("Couldn't start an HTTP client.")?;
    let response = request
        .send()
        .await
        .map_err(|e| format!("Couldn't reach GitHub: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("GitHub answered {} listing releases.", response.status()));
    }
    let releases: Vec<GitHubRelease> = response
        .json()
        .await
        .map_err(|e| format!("Couldn't read GitHub's release list: {e}"))?;
    let url = releases
        .into_iter()
        .filter(|r| !r.draft)
        .filter_map(|r| {
            let version = Version::parse(r.tag_name.trim_start_matches('v')).ok()?;
            let manifest = r.assets.into_iter().find(|a| a.name == "latest.json")?;
            Some((version, manifest.browser_download_url))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, url)| url)
        .ok_or("No release has an update manifest yet.")?;
    Url::parse(&url).map_err(|e| e.to_string())
}

/// Downloads the update `update_check` found, then stops every agent and
/// terminal and installs it. On Windows the installer closes Hive and opens
/// it again; elsewhere Hive restarts itself. Only returns on failure.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    updates: State<'_, Updates>,
    engine: State<'_, Engine>,
    terminals: State<'_, Terminals>,
    on_progress: Channel<UpdateProgress>,
) -> Result<(), String> {
    let update = updates
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or("There's no update to install.")?;

    let mut downloaded = 0u64;
    let mut reported = 0u64;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                if downloaded - reported >= PROGRESS_STEP || Some(downloaded) == total {
                    reported = downloaded;
                    let _ = on_progress.send(UpdateProgress::Downloading { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| format!("Couldn't download the update: {e}"))?;

    let _ = on_progress.send(UpdateProgress::Installing);
    engine.shutdown(SHUTDOWN_GRACE).await;
    terminals.kill_all();
    update
        .install(bytes)
        .map_err(|e| format!("Couldn't install the update: {e}"))?;
    app.restart()
}
