//! Commit authors' GitHub profile pictures for the history tab. Git keeps only
//! names and emails: a GitHub noreply email names its account outright;
//! otherwise a page of the repository's commits from GitHub's API maps commits
//! and emails to accounts. Returns image URLs (the webview loads and caches
//! them). Best effort: anything not found keeps the author's initial.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

use serde::Deserialize;

use crate::http;

/// Twice the size the history tab draws them at.
const SIZE: u32 = 40;

#[derive(Default)]
pub struct Avatars {
    /// `owner/repo|page|per_page` already read (a failure is forgotten, so a
    /// refresh tries again).
    pages: Mutex<HashSet<String>>,
    /// `owner/repo|sha|…` and `owner/repo|email|…` → the picture's URL.
    urls: Mutex<HashMap<String, String>>,
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

/// The authors' pictures that could be found, as URLs by lowercased email.
/// `cursor`/`limit` say which page of the history the authors are from, which
/// picks the page of GitHub's commit list to read.
#[tauri::command]
pub async fn git_avatars(
    avatars: tauri::State<'_, Avatars>,
    cwd: String,
    authors: Vec<AvatarAuthor>,
    cursor: Option<usize>,
    limit: Option<usize>,
) -> Result<HashMap<String, String>, String> {
    let authors: Vec<_> = authors
        .into_iter()
        .take(outcode_git::HISTORY_MAX_LIMIT)
        .filter(|a| a.sha.len() <= 64 && a.email.len() <= 512)
        .map(|a| {
            (
                a.sha.to_ascii_lowercase(),
                a.email.trim().to_ascii_lowercase(),
            )
        })
        .collect();
    let mut out = HashMap::new();
    for (_, email) in &authors {
        if let Some(url) = noreply_avatar(email) {
            out.insert(email.clone(), url);
        }
    }
    if out.len() == authors.len() {
        return Ok(out);
    }

    let Some((owner, repo)) = outcode_git::github_remote(Path::new(&cwd)).await else {
        return Ok(out);
    };
    let repo_key = format!("{owner}/{repo}").to_ascii_lowercase();
    let per_page = limit.unwrap_or(100).clamp(1, 100);
    let page = cursor.unwrap_or(0) / per_page + 1;
    let page_key = format!("{repo_key}|{page}|{per_page}");
    let fetch = avatars.pages.lock().unwrap().insert(page_key.clone());
    if fetch && !read_page(&avatars, &owner, &repo, &repo_key, page, per_page).await {
        avatars.pages.lock().unwrap().remove(&page_key);
    }

    let urls = avatars.urls.lock().unwrap();
    for (sha, email) in authors {
        if out.contains_key(&email) {
            continue;
        }
        let found = urls
            .get(&format!("{repo_key}|sha|{sha}"))
            .or_else(|| urls.get(&format!("{repo_key}|email|{email}")));
        if let Some(url) = found {
            out.insert(email, url.clone());
        }
    }
    Ok(out)
}

/// `123+name@users.noreply.github.com` → account 123's picture;
/// `name@users.noreply.github.com` → `name`'s.
fn noreply_avatar(email: &str) -> Option<String> {
    let local = email.strip_suffix("@users.noreply.github.com")?;
    let valid = |s: &str| !s.is_empty() && s.len() <= 64;
    match local.split_once('+') {
        Some((id, _)) if valid(id) && id.bytes().all(|b| b.is_ascii_digit()) => Some(format!(
            "https://avatars.githubusercontent.com/u/{id}?s={SIZE}&v=4"
        )),
        None if valid(local)
            && local
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-') =>
        {
            Some(format!("https://github.com/{local}.png?size={SIZE}"))
        }
        _ => None,
    }
}

/// Reads one page of the repository's commits from GitHub and remembers its
/// authors' pictures; false when GitHub couldn't be read.
async fn read_page(
    avatars: &Avatars,
    owner: &str,
    repo: &str,
    repo_key: &str,
    page: usize,
    per_page: usize,
) -> bool {
    // Owner and repo are checked to be URL-safe by `github_remote`.
    let Some(request) = http::github_get(&format!(
        "https://api.github.com/repos/{owner}/{repo}/commits?per_page={per_page}&page={page}"
    )) else {
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
    let mut urls = avatars.urls.lock().unwrap();
    for row in rows {
        let Some(user) = row.author else { continue };
        if !user.avatar_url.starts_with("https://") {
            continue;
        }
        let separator = if user.avatar_url.contains('?') {
            '&'
        } else {
            '?'
        };
        let url = format!("{}{separator}s={SIZE}", user.avatar_url);
        let email = row.commit.author.email.trim().to_ascii_lowercase();
        urls.insert(
            format!("{repo_key}|sha|{}", row.sha.to_ascii_lowercase()),
            url.clone(),
        );
        if !email.is_empty() {
            urls.insert(format!("{repo_key}|email|{email}"), url);
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noreply_emails() {
        assert_eq!(
            noreply_avatar("123+someone@users.noreply.github.com").as_deref(),
            Some("https://avatars.githubusercontent.com/u/123?s=40&v=4")
        );
        assert_eq!(
            noreply_avatar("someone@users.noreply.github.com").as_deref(),
            Some("https://github.com/someone.png?size=40")
        );
        assert_eq!(noreply_avatar("a+b@users.noreply.github.com"), None);
        assert_eq!(noreply_avatar("someone@example.com"), None);
    }
}
