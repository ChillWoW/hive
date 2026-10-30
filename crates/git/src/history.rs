//! A checkout's commit history for the history tab (zeron's `Repos::history`
//! and friends): pages in topological order over every branch, remote branch
//! and tag, a search through all of it, Fetch all, and one commit's patch.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;

use hive_proto::{
    GitDiff, GitHistoryCommit, GitHistoryComparison, GitHistoryPage, GitHistoryRef,
    GitHistoryRefKind,
};

use super::diff::{capped, EMPTY_TREE, MAX_PATCH_BYTES};
use super::{git, GitError};

pub const HISTORY_DEFAULT_LIMIT: usize = 100;
pub const HISTORY_MAX_LIMIT: usize = 200;

/// Fetching gives up after this; a remote asking for a password never answers.
const FETCH_TIMEOUT: Duration = Duration::from_secs(120);

const LOG_FORMAT: &str = "--format=%H%x00%P%x00%s%x00%an%x00%ae%x00%aI%x00";
const REF_FORMAT: &str = "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)%00";

/// The checkout's top folder; `None` outside one.
async fn root_of(cwd: &Path) -> Result<Option<String>, GitError> {
    if !cwd.is_dir() {
        return Ok(None);
    }
    let top = git(cwd, &["rev-parse", "--show-toplevel"]).await?;
    if !top.ok() {
        if top.stderr.contains("not a git repository") {
            return Ok(None);
        }
        return Err(top.error());
    }
    Ok(Some(top.stdout.trim().to_owned()))
}

async fn head_sha(root: &Path) -> Result<Option<String>, GitError> {
    let out = git(root, &["rev-parse", "--verify", "-q", "HEAD^{commit}"]).await?;
    Ok(out
        .ok()
        .then(|| out.stdout.trim().to_owned())
        .filter(|sha| !sha.is_empty()))
}

/// Every branch, remote branch and tag, by the commit it points at.
async fn refs_by_sha(root: &Path) -> Result<HashMap<String, Vec<GitHistoryRef>>, GitError> {
    let out = git(
        root,
        &["for-each-ref", REF_FORMAT, "refs/heads", "refs/remotes", "refs/tags"],
    )
    .await?
    .checked()?;
    Ok(parse_refs(&out))
}

/// `git log` over HEAD and every public ref (Hive's own refs never seed it).
fn log_args<'a>(head: bool, extra: &[&'a str]) -> Vec<&'a str> {
    let mut args = vec![
        "-c",
        "log.showSignature=false",
        "log",
        "--no-color",
        "--no-decorate",
        "--no-patch",
    ];
    args.extend_from_slice(extra);
    args.push(LOG_FORMAT);
    if head {
        args.push("HEAD");
    }
    args
}

fn empty_page() -> GitHistoryPage {
    GitHistoryPage {
        commits: Vec::new(),
        branch_tips: Vec::new(),
        head_sha: None,
        next_cursor: None,
        total_count: Some(0),
        head_commit_count: Some(0),
        comparison: None,
    }
}

/// `limit` commits from `cursor` on, children before parents; `None` outside
/// a checkout. The first page also carries the branch tips, counts and the
/// comparison with the integration branch.
pub async fn history(
    cwd: &Path,
    cursor: usize,
    limit: usize,
) -> Result<Option<GitHistoryPage>, GitError> {
    let Some(root) = root_of(cwd).await? else {
        return Ok(None);
    };
    let root = Path::new(&root);
    let limit = limit.clamp(1, HISTORY_MAX_LIMIT);
    let head = head_sha(root).await?;
    let refs = refs_by_sha(root).await?;
    if head.is_none() && refs.is_empty() {
        return Ok(Some(empty_page()));
    }
    let has_head = head.is_some();

    let skip = format!("--skip={cursor}");
    let max = format!("--max-count={}", limit + 1);
    let mut args = log_args(has_head, &["--topo-order", &skip, &max]);
    args.extend(["--branches", "--remotes", "--tags"]);
    let page = async { git(root, &args).await?.checked() };

    let first = cursor == 0;
    let tips = async {
        if !first {
            return Ok(String::new());
        }
        // Each local and remote tip once (HEAD too, for a detached checkout);
        // tags don't add rows here.
        let mut args = log_args(has_head, &["--no-walk=sorted"]);
        args.extend(["--branches", "--remotes"]);
        git(root, &args).await?.checked()
    };
    let total = async {
        if !first {
            return None;
        }
        let mut args = vec!["rev-list", "--count"];
        if has_head {
            args.push("HEAD");
        }
        args.extend(["--branches", "--remotes", "--tags"]);
        count(root, &args).await
    };
    let head_count = async {
        if first && has_head {
            count(root, &["rev-list", "--count", "HEAD"]).await
        } else {
            None
        }
    };
    let comparison = async {
        if first && has_head {
            comparison(root).await
        } else {
            None
        }
    };
    let (page, tips, total, head_count, comparison) =
        tokio::join!(page, tips, total, head_count, comparison);

    let mut commits = parse_log(&page?, &refs);
    let has_next = commits.len() > limit;
    commits.truncate(limit);
    Ok(Some(GitHistoryPage {
        next_cursor: has_next.then(|| (cursor + commits.len()) as u32),
        commits,
        branch_tips: parse_log(&tips?, &refs),
        head_sha: head,
        total_count: total,
        head_commit_count: head_count,
        comparison,
    }))
}

async fn count(root: &Path, args: &[&str]) -> Option<u32> {
    let out = git(root, args).await.ok()?;
    out.ok().then(|| out.stdout.trim().parse().ok()).flatten()
}

/// The checked-out branch against the best local integration ref: a remote's
/// HEAD (`upstream` before `origin`), else their main / master, else the
/// branch's upstream. Never touches the network.
async fn comparison(root: &Path) -> Option<GitHistoryComparison> {
    // A detached HEAD has no branch to compare.
    let branch = git(root, &["symbolic-ref", "-q", "--short", "HEAD"]).await.ok()?;
    if !branch.ok() {
        return None;
    }
    let mut candidates = Vec::new();
    for remote in ["upstream", "origin"] {
        let remote_head = format!("refs/remotes/{remote}/HEAD");
        if let Ok(out) = git(root, &["symbolic-ref", "-q", "--short", &remote_head]).await {
            let base = out.stdout.trim();
            if out.ok() && !base.is_empty() {
                candidates.push(base.to_owned());
            }
        }
    }
    candidates.extend(
        ["upstream/main", "origin/main", "upstream/master", "origin/master"].map(String::from),
    );
    if let Ok(out) = git(
        root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    )
    .await
    {
        let base = out.stdout.trim();
        if out.ok() && !base.is_empty() {
            candidates.push(base.to_owned());
        }
    }

    let mut seen = HashSet::new();
    for base in candidates.into_iter().filter(|b| seen.insert(b.clone())) {
        let range = format!("HEAD...{base}");
        let Ok(out) = git(root, &["rev-list", "--left-right", "--count", &range]).await else {
            continue;
        };
        if !out.ok() {
            continue; // no such ref
        }
        let mut counts = out.stdout.split_whitespace().map(str::parse::<u32>);
        if let (Some(Ok(ahead)), Some(Ok(behind))) = (counts.next(), counts.next()) {
            return Some(GitHistoryComparison {
                base,
                ahead,
                behind,
            });
        }
    }
    None
}

/// The commits whose short hash starts with `query`, or whose hash and
/// subject hold each of its words as a subsequence, through all of the
/// history. Kept in topological order (the score never reorders) with
/// parents carried across the commits left out, so the graph still connects.
pub async fn search_history(
    cwd: &Path,
    query: &str,
    cursor: usize,
    limit: usize,
) -> Result<Option<GitHistoryPage>, GitError> {
    let Some(root) = root_of(cwd).await? else {
        return Ok(None);
    };
    let root = Path::new(&root);
    let query = query.trim();
    let mut page = empty_page();
    page.head_commit_count = None;
    if query.is_empty() {
        return Ok(Some(page));
    }
    let limit = limit.clamp(1, HISTORY_MAX_LIMIT);
    let head = head_sha(root).await?;
    let refs = refs_by_sha(root).await?;
    if head.is_none() && refs.is_empty() {
        return Ok(Some(page));
    }
    let mut args = log_args(head.is_some(), &["--topo-order"]);
    args.extend(["--branches", "--remotes", "--tags"]);
    let all = parse_log(&git(root, &args).await?.checked()?, &refs);
    let visible: HashSet<&str> = all
        .iter()
        .filter(|c| history_matches(query, c))
        .map(|c| c.sha.as_str())
        .collect();
    let matches = compact_to_visible(&all, &visible);
    let total = matches.len();
    let start = cursor.min(total);
    let end = start.saturating_add(limit).min(total);
    page.commits = matches[start..end].to_vec();
    page.head_sha = head;
    page.next_cursor = (end < total).then_some(end as u32);
    page.total_count = Some(total as u32);
    Ok(Some(page))
}

/// The history search's match: the hash starts with `query`, or each of its
/// words is a subsequence of "hash subject", case-insensitively. The
/// history tab filters loaded rows the same way (`src/history/graph.ts`).
pub fn history_matches(query: &str, commit: &GitHistoryCommit) -> bool {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return true;
    }
    if commit.sha.starts_with(&query) {
        return true;
    }
    let haystack = format!("{} {}", commit.sha, commit.subject).to_lowercase();
    query.split_whitespace().all(|term| {
        let mut rest = haystack.chars();
        term.chars().all(|c| rest.any(|h| h == c))
    })
}

/// The `visible` commits, in order, each parent outside the set replaced by
/// its nearest visible ancestors (a parent not in `commits` stays as is).
pub(crate) fn compact_to_visible(
    commits: &[GitHistoryCommit],
    visible: &HashSet<&str>,
) -> Vec<GitHistoryCommit> {
    let listed: HashSet<&str> = commits.iter().map(|c| c.sha.as_str()).collect();
    // Topological order lists every parent after its children, so walking
    // backwards resolves each hidden commit's parents before the commit.
    let mut resolved: HashMap<&str, Vec<&str>> = HashMap::new();
    for commit in commits.iter().rev() {
        if !visible.contains(commit.sha.as_str()) {
            let parents = lift_parents(commit, visible, &listed, &resolved);
            resolved.insert(commit.sha.as_str(), parents);
        }
    }
    commits
        .iter()
        .filter(|c| visible.contains(c.sha.as_str()))
        .map(|c| GitHistoryCommit {
            parent_shas: lift_parents(c, visible, &listed, &resolved)
                .into_iter()
                .map(str::to_owned)
                .collect(),
            ..c.clone()
        })
        .collect()
}

/// `commit`'s parents, each hidden one replaced by what it resolved to.
fn lift_parents<'a>(
    commit: &'a GitHistoryCommit,
    visible: &HashSet<&str>,
    listed: &HashSet<&str>,
    resolved: &HashMap<&'a str, Vec<&'a str>>,
) -> Vec<&'a str> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for parent in &commit.parent_shas {
        let parent = parent.as_str();
        let lifted = if visible.contains(parent) || !listed.contains(parent) {
            std::slice::from_ref(&parent)
        } else {
            resolved.get(parent).map_or(&[][..], Vec::as_slice)
        };
        for &sha in lifted {
            if seen.insert(sha) {
                out.push(sha);
            }
        }
    }
    out
}

/// Updates every remote's branches (`git fetch --all`), never HEAD, the
/// index or any file.
pub async fn fetch_all(cwd: &Path) -> Result<(), GitError> {
    let fetch = git(cwd, &["fetch", "--all", "--quiet"]);
    match tokio::time::timeout(FETCH_TIMEOUT, fetch).await {
        Ok(out) => out?.checked().map(drop),
        Err(_) => Err(GitError::Failed("Fetching took too long.".into())),
    }
}

/// What commit `sha` changed (against its first parent, or nothing for a
/// root commit) as one patch; `None` outside a checkout.
pub async fn commit_diff(cwd: &Path, sha: &str) -> Result<Option<GitDiff>, GitError> {
    if sha.len() < 4 || sha.len() > 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(GitError::Failed(format!("“{sha}” isn't a commit.")));
    }
    let Some(root_text) = root_of(cwd).await? else {
        return Ok(None);
    };
    let root = Path::new(&root_text);
    let spec = format!("{sha}^{{commit}}");
    let commit = git(root, &["rev-parse", "--verify", "-q", &spec]).await?;
    if !commit.ok() {
        return Err(GitError::Failed(format!("There's no commit “{sha}” here.")));
    }
    let commit = commit.stdout.trim().to_owned();
    let parent_spec = format!("{commit}^");
    let parent = git(root, &["rev-parse", "--verify", "-q", &parent_spec]).await?;
    let parent = parent
        .ok()
        .then(|| parent.stdout.trim().to_owned())
        .filter(|p| !p.is_empty());
    let against = parent.clone().unwrap_or_else(|| EMPTY_TREE.to_owned());
    let (bytes, truncated) = capped(
        root,
        &[
            "-c",
            "core.quotePath=false",
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--find-renames",
            "--unified=3",
            &against,
            &commit,
            "--",
        ],
        MAX_PATCH_BYTES,
    )
    .await?;
    let mut patch = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        patch.truncate(patch.rfind('\n').map_or(0, |i| i + 1));
    }
    Ok(Some(GitDiff {
        root: root_text,
        branch: None,
        merge_base: parent.map(|p| p.chars().take(7).collect()),
        patch,
        truncated,
    }))
}

/// `(owner, repo)` of the GitHub repository `origin` points at, if it does.
pub async fn github_remote(cwd: &Path) -> Option<(String, String)> {
    let out = git(cwd, &["remote", "get-url", "origin"]).await.ok()?;
    if !out.ok() {
        return None;
    }
    parse_github_remote(out.stdout.trim())
}

/// `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)`,
/// `ssh://git@github.com/o/r(.git)` → `(o, r)`.
fn parse_github_remote(url: &str) -> Option<(String, String)> {
    let path = url
        .strip_prefix("git@github.com:")
        .or_else(|| {
            let rest = url
                .strip_prefix("https://")
                .or_else(|| url.strip_prefix("http://"))
                .or_else(|| url.strip_prefix("ssh://"))?;
            // Credentials or a user before the host.
            let rest = rest.rsplit_once('@').map_or(rest, |(_, host)| host);
            rest.strip_prefix("github.com/")
                .or_else(|| rest.strip_prefix("www.github.com/"))
        })?;
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, repo) = path.split_once('/')?;
    let valid = |s: &str| {
        !s.is_empty()
            && s.len() <= 100
            && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    (valid(owner) && valid(repo) && !repo.contains('/')).then(|| (owner.to_owned(), repo.to_owned()))
}

/// A field cut to at most `max` bytes, on a character boundary.
fn bounded(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_owned();
    }
    let mut end = max;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn parse_log(output: &str, refs: &HashMap<String, Vec<GitHistoryRef>>) -> Vec<GitHistoryCommit> {
    let fields: Vec<&str> = output.split('\0').collect();
    fields
        .chunks(6)
        .filter(|record| record.len() == 6)
        .filter_map(|record| {
            let sha = record[0].trim_start_matches(['\r', '\n']);
            if sha.is_empty() {
                return None;
            }
            Some(GitHistoryCommit {
                sha: sha.to_owned(),
                parent_shas: record[1].split_ascii_whitespace().map(str::to_owned).collect(),
                subject: bounded(record[2], 4096),
                author_name: bounded(record[3], 512),
                author_email: bounded(record[4], 512),
                authored_at: bounded(record[5], 128),
                refs: refs.get(sha).cloned().unwrap_or_default(),
            })
        })
        .collect()
}

fn parse_refs(output: &str) -> HashMap<String, Vec<GitHistoryRef>> {
    let fields: Vec<&str> = output.split('\0').collect();
    let mut by_sha: HashMap<String, Vec<GitHistoryRef>> = HashMap::new();
    for record in fields.chunks(6).filter(|r| r.len() == 6) {
        let name = record[0].trim_start_matches(['\r', '\n']);
        let (object, object_type, peeled, peeled_type, symref) =
            (record[1], record[2], record[3], record[4], record[5]);
        // `origin/HEAD` and other symbolic refs repeat a real one.
        if name.is_empty() || !symref.is_empty() {
            continue;
        }
        let (kind, label) = if let Some(label) = name.strip_prefix("refs/heads/") {
            (GitHistoryRefKind::Branch, label)
        } else if let Some(label) = name.strip_prefix("refs/remotes/") {
            (GitHistoryRefKind::Remote, label)
        } else if let Some(label) = name.strip_prefix("refs/tags/") {
            (GitHistoryRefKind::Tag, label)
        } else {
            continue;
        };
        let target = match (object_type, peeled_type) {
            ("commit", _) => object,
            ("tag", "commit") => peeled,
            _ => continue,
        };
        by_sha.entry(target.to_owned()).or_default().push(GitHistoryRef {
            kind,
            label: bounded(label, 1024),
        });
    }
    for refs in by_sha.values_mut() {
        let order = |kind: GitHistoryRefKind| match kind {
            GitHistoryRefKind::Branch => 0,
            GitHistoryRefKind::Tag => 1,
            GitHistoryRefKind::Remote => 2,
        };
        refs.sort_by(|a, b| order(a.kind).cmp(&order(b.kind)).then(a.label.cmp(&b.label)));
    }
    by_sha
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(sha: &str, parents: &[&str], subject: &str) -> GitHistoryCommit {
        GitHistoryCommit {
            sha: sha.into(),
            parent_shas: parents.iter().map(|p| (*p).into()).collect(),
            subject: subject.into(),
            author_name: "A".into(),
            author_email: "a@example.com".into(),
            authored_at: "2026-01-01T00:00:00+00:00".into(),
            refs: Vec::new(),
        }
    }

    #[test]
    fn matches_hash_prefix_and_word_subsequences() {
        let c = commit("abc123", &[], "feat: History graph");
        assert!(history_matches("abc", &c));
        assert!(history_matches("hist grph", &c));
        assert!(history_matches("FEAT", &c));
        assert!(!history_matches("graph history x", &c));
        assert!(!history_matches("zzz", &c));
    }

    #[test]
    fn compaction_connects_across_hidden_commits() {
        // a → b → c → d, with a merge e(b, d) on top.
        let commits = vec![
            commit("e", &["b", "d"], ""),
            commit("b", &["c"], ""),
            commit("d", &["c"], ""),
            commit("c", &["x"], ""),
        ];
        let visible: HashSet<&str> = ["e", "c"].into();
        let out = compact_to_visible(&commits, &visible);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].parent_shas, vec!["c"]);
        // A parent that isn't listed stays as it is.
        assert_eq!(out[1].parent_shas, vec!["x"]);
    }

    #[test]
    fn compaction_handles_a_long_gap() {
        let mut commits = vec![commit("top", &["h0"], "")];
        for i in 0..20_000 {
            commits.push(commit(&format!("h{i}"), &[&format!("h{}", i + 1)], ""));
        }
        commits.push(commit("h20000", &[], ""));
        let visible: HashSet<&str> = ["top", "h20000"].into();
        let out = compact_to_visible(&commits, &visible);
        assert_eq!(out[0].parent_shas, vec!["h20000"]);
    }

    #[test]
    fn github_remotes() {
        let want = Some(("ChillWoW".to_owned(), "hive".to_owned()));
        assert_eq!(parse_github_remote("https://github.com/ChillWoW/hive.git"), want);
        assert_eq!(parse_github_remote("git@github.com:ChillWoW/hive.git"), want);
        assert_eq!(parse_github_remote("ssh://git@github.com/ChillWoW/hive"), want);
        assert_eq!(parse_github_remote("https://user:tok@github.com/ChillWoW/hive/"), want);
        assert_eq!(parse_github_remote("https://gitlab.com/ChillWoW/hive.git"), None);
    }

    #[test]
    fn refs_skip_symbolic_and_peel_tags() {
        let out = "refs/heads/main\0aaa\0commit\0\0\0\0\n\
                   refs/remotes/origin/HEAD\0aaa\0commit\0\0\0refs/remotes/origin/main\0\n\
                   refs/remotes/origin/main\0aaa\0commit\0\0\0\0\n\
                   refs/tags/v1\0ttt\0tag\0aaa\0commit\0\0\n";
        let refs = parse_refs(out);
        let labels: Vec<_> = refs["aaa"].iter().map(|r| r.label.as_str()).collect();
        assert_eq!(labels, vec!["main", "v1", "origin/main"]);
    }

    /// A real repository: two branches, a merge, a tag.
    #[tokio::test]
    async fn pages_a_real_history() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "T")
                .env("GIT_AUTHOR_EMAIL", "t@example.com")
                .env("GIT_COMMITTER_NAME", "T")
                .env("GIT_COMMITTER_EMAIL", "t@example.com")
                .output()
                .unwrap();
            assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["commit", "-q", "--allow-empty", "-m", "one"]);
        run(&["switch", "-q", "-c", "side"]);
        std::fs::write(root.join("side.txt"), "side\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "side work"]);
        run(&["switch", "-q", "main"]);
        run(&["commit", "-q", "--allow-empty", "-m", "two"]);
        run(&["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
        run(&["tag", "-a", "v1", "-m", "v1"]);

        let page = history(root, 0, 2).await.unwrap().unwrap();
        assert_eq!(page.commits.len(), 2);
        assert_eq!(page.commits[0].subject, "merge side");
        assert_eq!(page.commits[0].parent_shas.len(), 2);
        assert_eq!(page.head_sha.as_deref(), Some(page.commits[0].sha.as_str()));
        let labels: Vec<_> = page.commits[0].refs.iter().map(|r| r.label.as_str()).collect();
        assert_eq!(labels, vec!["main", "v1"]);
        assert_eq!(page.total_count, Some(4));
        assert_eq!(page.head_commit_count, Some(4));
        assert_eq!(page.next_cursor, Some(2));
        assert_eq!(page.branch_tips.len(), 2);

        let rest = history(root, 2, 10).await.unwrap().unwrap();
        assert_eq!(rest.commits.len(), 2);
        assert_eq!(rest.next_cursor, None);
        assert!(rest.branch_tips.is_empty());

        let found = search_history(root, "side work", 0, 10).await.unwrap().unwrap();
        assert_eq!(found.commits.len(), 1);
        assert_eq!(found.total_count, Some(1));

        let side = &found.commits[0].sha;
        let diff = commit_diff(root, side).await.unwrap().unwrap();
        assert!(diff.patch.contains("+++ b/side.txt"));
        let first = &rest.commits[1].sha;
        let diff = commit_diff(root, first).await.unwrap().unwrap();
        assert!(diff.patch.is_empty() && diff.merge_base.is_none());

        assert!(history(&root.join("missing"), 0, 10).await.unwrap().is_none());
    }
}
