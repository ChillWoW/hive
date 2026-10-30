//! Semantic worktree branch names: `<type>/<slug>`, both written by the
//! text generation model from the chat's first prompt (one quick attempt,
//! since the chat waits on its worktree), else the type guessed from the
//! prompt's words and the slug made from them.

use std::time::Duration;

use hive_proto::HarnessId;

use crate::Engine;

/// The kinds a branch can be, as in Conventional Commits.
const TYPES: [&str; 10] = [
    "feat", "fix", "refactor", "perf", "docs", "test", "style", "build", "ci", "chore",
];

const BRANCH_INSTRUCTIONS: &str = "Name a git branch for this session. Return only \
    `<type>/<slug>`, nothing else: type is one of feat, fix, refactor, perf, docs, test, style, \
    build, ci, chore, for the kind of change the request asks for; slug is 2-4 lowercase words \
    joined by hyphens saying what changes, without the type's word (fix/login-redirect, \
    feat/dark-mode).";

/// How long the chat waits on the model before guessing.
const BRANCH_TIMEOUT: Duration = Duration::from_secs(20);

impl Engine {
    /// The prefix and slug hint for a new worktree's branch.
    pub(crate) async fn semantic_branch(
        &self,
        chat_harness: HarnessId,
        prompt: &str,
    ) -> (String, String) {
        if !prompt.trim().is_empty() {
            let named = self
                .generate_text(
                    chat_harness,
                    BRANCH_INSTRUCTIONS,
                    prompt,
                    &[],
                    BRANCH_TIMEOUT,
                    parse_branch,
                )
                .await;
            if let Some(named) = named {
                return named;
            }
        }
        guess_branch(prompt)
    }
}

/// `type/slug` from the model's answer: its first line, quotes and
/// backticks dropped; None unless the type is one of [`TYPES`].
fn parse_branch(raw: &str) -> Option<(String, String)> {
    let line = raw.trim().lines().next()?.trim_matches(['`', '"', '\'', ' ', '\t']);
    let (kind, slug) = line.split_once('/')?;
    let kind = kind.trim().to_ascii_lowercase();
    let slug = slug.trim();
    (TYPES.contains(&kind.as_str()) && slug.chars().any(|c| c.is_ascii_alphanumeric()))
        .then(|| (kind, slug.to_owned()))
}

/// The type the prompt's words point to (feat when none do), and the prompt
/// as the slug's hint, without a leading word that only repeats the type.
fn guess_branch(prompt: &str) -> (String, String) {
    const KEYWORDS: [(&str, &[&str]); 6] = [
        ("fix", &["fix", "bug", "broken", "crash", "crashes", "error", "fails", "failing", "issue", "wrong"]),
        ("refactor", &["refactor", "cleanup", "clean", "restructure", "simplify", "rename", "tidy"]),
        ("perf", &["perf", "performance", "faster", "slow", "optimize", "optimise", "speed"]),
        ("docs", &["docs", "doc", "documentation", "readme", "document", "comments"]),
        ("test", &["test", "tests", "testing", "spec", "coverage"]),
        ("chore", &["bump", "upgrade", "dependency", "dependencies", "deps", "chore"]),
    ];
    let words: Vec<String> = prompt
        .split(|c: char| !c.is_ascii_alphanumeric())
        .map(str::to_ascii_lowercase)
        .filter(|w| !["", "a", "an", "the", "please"].contains(&w.as_str()))
        .collect();
    let kind = KEYWORDS
        .iter()
        .find(|(_, keys)| words.iter().any(|w| keys.contains(&w.as_str())))
        .map_or("feat", |(kind, _)| kind);
    let lead = ["add", "implement", "create", kind];
    let hint = match words.first() {
        Some(first) if words.len() > 1 && lead.contains(&first.as_str()) => words[1..].join(" "),
        _ => words.join(" "),
    };
    (kind.to_owned(), hint)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(kind: &str, slug: &str) -> Option<(String, String)> {
        Some((kind.into(), slug.into()))
    }

    #[test]
    fn model_answers_are_parsed() {
        assert_eq!(parse_branch("fix/login-redirect"), pair("fix", "login-redirect"));
        assert_eq!(parse_branch("`Feat/dark-mode`\nmore"), pair("feat", "dark-mode"));
        assert_eq!(parse_branch("Fix The Login Bug"), None);
        assert_eq!(parse_branch("bugfix/login"), None);
        assert_eq!(parse_branch("fix/"), None);
    }

    #[test]
    fn the_guess_reads_the_prompts_words() {
        let guess = |p: &str| guess_branch(p);
        assert_eq!(guess("Fix the login bug"), ("fix".into(), "login bug".into()));
        assert_eq!(guess("Add a dark mode toggle"), ("feat".into(), "dark mode toggle".into()));
        assert_eq!(guess("the app crashes on start"), ("fix".into(), "app crashes on start".into()));
        assert_eq!(guess("Refactor the store"), ("refactor".into(), "store".into()));
        assert_eq!(guess(""), ("feat".into(), String::new()));
    }
}
