//! The app's HTTP client, shared by the GitHub lookups (`avatars.rs`,
//! `updater.rs`).

use std::sync::OnceLock;
use std::time::Duration;

pub fn client() -> Option<&'static reqwest::Client> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            // Fails when one is already installed, which is fine.
            let _ = rustls::crypto::ring::default_provider().install_default();
            reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                // GitHub's API refuses requests without one.
                .user_agent("hive-desktop")
                .build()
                .ok()
        })
        .as_ref()
}

/// A GET on GitHub's REST API. A `GITHUB_TOKEN`/`GH_TOKEN` in the
/// environment lifts the 60-an-hour limit and reaches private repositories.
pub fn github_get(url: &str) -> Option<reqwest::RequestBuilder> {
    let mut request = client()?
        .get(url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json");
    if let Some(token) = ["GITHUB_TOKEN", "GH_TOKEN"]
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|t| !t.is_empty()))
    {
        request = request.bearer_auth(token);
    }
    Some(request)
}
