//! Commit authors' GitHub profile pictures for the history tab, as zeron's
//! `ResolveGitAvatars`. Git keeps only names and emails, so a page of the
//! repository's commits from GitHub's API maps commits and emails to avatar
//! URLs; each image is downloaded once into `<data dir>/cache/git-avatars`.
//! Best effort: any failure just leaves the initial in place.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine as _;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::task::JoinSet;

use crate::http;

const MAX_AVATAR_BYTES: usize = 2 * 1024 * 1024;
/// Downloads at once.
const PARALLEL: usize = 8;

pub struct Avatars {
    dir: PathBuf,
    /// `owner/repo|page|per_page` already asked for (a failure is forgotten,
    /// so a refresh tries again).
    pages: Mutex<HashSet<String>>,
    /// `owner/repo|sha|…` and `owner/repo|email|…` → the cached image.
    images: Mutex<HashMap<String, PathBuf>>,
}

impl Avatars {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("cache").join("git-avatars"),
            pages: Mutex::default(),
            images: Mutex::default(),
        }
    }
}

#[derive(Deserialize)]
pub struct AvatarAuthor {
    sha: String,
    email: String,
}

#[derive(Deserialize)]
struct GitHubCommit {
    sha: String,
    commit: GitHubCommitDetail,
    author: Option<GitHubUser>,
}

#[derive(Deserialize)]
struct GitHubCommitDetail {
    author: GitHubIdentity,
}

#[derive(Deserialize)]
struct GitHubIdentity {
    #[serde(default)]
    email: String,
}

#[derive(Deserialize)]
struct GitHubUser {
    avatar_url: String,
}

/// The authors' pictures that could be found, as `data:` URLs keyed by
/// lowercased email. `cursor`/`limit` say which page of the history the
/// authors are from, which picks the page of GitHub's commit list to read.
#[tauri::command]
pub async fn git_avatars(
    avatars: tauri::State<'_, Avatars>,
    cwd: String,
    authors: Vec<AvatarAuthor>,
    cursor: Option<usize>,
    limit: Option<usize>,
) -> Result<HashMap<String, String>, String> {
    let Some((owner, repo)) = hive_git::github_remote(Path::new(&cwd)).await else {
        return Ok(HashMap::new());
    };
    let repo_key = format!("{owner}/{repo}").to_ascii_lowercase();
    let per_page = limit.unwrap_or(100).clamp(1, 100);
    let page = cursor.unwrap_or(0) / per_page + 1;
    let page_key = format!("{repo_key}|{page}|{per_page}");
    let fetch = avatars.pages.lock().unwrap().insert(page_key.clone());
    if fetch && !read_page(&avatars, &owner, &repo, &repo_key, page, per_page).await {
        avatars.pages.lock().unwrap().remove(&page_key);
    }

    let paths: Vec<(String, PathBuf)> = {
        let images = avatars.images.lock().unwrap();
        authors
            .iter()
            .take(hive_git::HISTORY_MAX_LIMIT)
            .filter(|a| a.sha.len() <= 64 && a.email.len() <= 512)
            .filter_map(|a| {
                let email = a.email.trim().to_ascii_lowercase();
                let path = images
                    .get(&format!("{repo_key}|sha|{}", a.sha.to_ascii_lowercase()))
                    .or_else(|| images.get(&format!("{repo_key}|email|{email}")))?;
                Some((email, path.clone()))
            })
            .collect()
    };
    let mut out = HashMap::new();
    for (email, path) in paths {
        if out.contains_key(&email) {
            continue;
        }
        if let Some(url) = tokio::fs::read(&path).await.ok().and_then(|b| data_url(&b)) {
            out.insert(email, url);
        }
    }
    Ok(out)
}

/// Reads one page of the repository's commits from GitHub and caches its
/// authors' pictures; false when GitHub couldn't be read.
async fn read_page(
    avatars: &Avatars,
    owner: &str,
    repo: &str,
    repo_key: &str,
    page: usize,
    per_page: usize,
) -> bool {
    let (Some(client), Some(request)) = (
        http::client(),
        // Owner and repo are checked to be URL-safe by `github_remote`.
        http::github_get(&format!(
            "https://api.github.com/repos/{owner}/{repo}/commits?per_page={per_page}&page={page}"
        )),
    ) else {
        return false;
    };
    let rows = match request.send().await {
        Ok(response) if response.status().is_success() => {
            match response.json::<Vec<GitHubCommit>>().await {
                Ok(rows) => rows,
                Err(_) => return false,
            }
        }
        _ => return false,
    };

    let mut by_url: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for row in rows {
        let Some(user) = row.author else { continue };
        if !user.avatar_url.starts_with("https://") {
            continue;
        }
        let separator = if user.avatar_url.contains('?') { '&' } else { '?' };
        // Twice the 20px it's drawn at.
        let url = format!("{}{separator}s=40", user.avatar_url);
        by_url.entry(url).or_default().push((
            row.sha.to_ascii_lowercase(),
            row.commit.author.email.trim().to_ascii_lowercase(),
        ));
    }

    let mut downloads = JoinSet::new();
    let mut pending = by_url.into_iter();
    let mut cached = Vec::new();
    loop {
        while downloads.len() < PARALLEL {
            let Some((url, identities)) = pending.next() else { break };
            let dir = avatars.dir.clone();
            downloads.spawn(async move {
                cache_image(client, &dir, &url).await.map(|path| (identities, path))
            });
        }
        match downloads.join_next().await {
            Some(Ok(Some(done))) => cached.push(done),
            Some(_) => {}
            None => break,
        }
    }
    let mut images = avatars.images.lock().unwrap();
    for (identities, path) in cached {
        for (sha, email) in identities {
            images.insert(format!("{repo_key}|sha|{sha}"), path.clone());
            if !email.is_empty() {
                images.insert(format!("{repo_key}|email|{email}"), path.clone());
            }
        }
    }
    true
}

/// `url`'s image in the cache folder, downloading it the first time.
async fn cache_image(client: &reqwest::Client, dir: &Path, url: &str) -> Option<PathBuf> {
    let digest = Sha256::digest(url.as_bytes());
    let name: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    let path = dir.join(format!("{name}.img"));
    if tokio::fs::metadata(&path).await.is_ok_and(|m| m.len() > 0) {
        return Some(path);
    }
    tokio::fs::create_dir_all(dir).await.ok()?;
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size as usize > MAX_AVATAR_BYTES)
    {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    if bytes.is_empty() || bytes.len() > MAX_AVATAR_BYTES || mime(&bytes).is_none() {
        return None;
    }
    // Written aside and renamed in, so a reader never sees half an image.
    let temp = dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(&temp, &bytes).await.ok()?;
    if tokio::fs::rename(&temp, &path).await.is_err() {
        let _ = tokio::fs::remove_file(&temp).await;
        if !path.is_file() {
            return None;
        }
    }
    Some(path)
}

fn mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

fn data_url(bytes: &[u8]) -> Option<String> {
    let mime = mime(bytes)?;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{mime};base64,{data}"))
}
