//! Antigravity's models. The list depends on the account, so it comes from
//! the CLI: `agy models` (kept [`TTL`], refreshed in the background), which
//! lists each thinking level as its own model (`gemini-3.8-flash-low`). A
//! session takes the family (`gemini-3.8-flash`) as its `model` and the level
//! as its `thought_level`, so variants fold into one model with levels.

use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use outcode_proto::{Model, ReasoningLevel};

use crate::cli;

/// How long an `agy models` answer is used before it's asked again.
const TTL: Duration = Duration::from_secs(10 * 60);
const LIST_TIMEOUT: Duration = Duration::from_secs(30);

/// The models and which one is the default.
#[derive(Debug, Clone, Default, PartialEq)]
pub(super) struct Models {
    pub models: Vec<Model>,
    pub default: Option<String>,
}

#[cfg(test)]
impl Models {
    fn get(&self, id: &str) -> Option<&Model> {
        self.models.iter().find(|m| m.id == id)
    }
}

/// The last `agy models` answer, shared by every run.
#[derive(Clone, Default)]
pub(super) struct Cache(Arc<Mutex<CacheState>>);

#[derive(Default)]
struct CacheState {
    listed: Option<(Instant, Models)>,
    refreshing: bool,
}

impl Cache {
    pub(super) fn models(&self) -> Option<Models> {
        self.0.lock().unwrap().listed.as_ref().map(|(_, m)| m.clone())
    }

    /// Lists them again in the background once the last answer is older
    /// than [`TTL`]. Outside a tokio runtime it does nothing.
    pub(super) fn refresh(&self, exe: &Path) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        {
            let mut state = self.0.lock().unwrap();
            let fresh = state.listed.as_ref().is_some_and(|(at, _)| at.elapsed() < TTL);
            if fresh || state.refreshing {
                return;
            }
            state.refreshing = true;
        }
        let cache = self.clone();
        let exe = exe.to_owned();
        runtime.spawn(async move {
            let listed = list(&exe).await;
            let mut state = cache.0.lock().unwrap();
            state.refreshing = false;
            match listed {
                Ok(models) if !models.models.is_empty() => state.listed = Some((Instant::now(), models)),
                Ok(_) => {}
                Err(error) => eprintln!("[agy] listing models: {error}"),
            }
        });
    }
}

/// `agy models`, once ACP says the CLI is signed in: signed out, it would
/// start Google's sign-in in the browser by itself.
async fn list(exe: &Path) -> Result<Models, String> {
    if !super::provider::signed_in(exe).await.map_err(|e| e.to_string())? {
        return Ok(Models::default());
    }
    let mut cmd = cli::command(exe);
    cmd.arg("models")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(home) = cli::home_dir() {
        cmd.current_dir(home);
    }
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    let out = tokio::time::timeout(LIST_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "agy didn't list its models".to_owned())?
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    Ok(parse(&String::from_utf8_lossy(&out.stdout)))
}

/// A thinking level as a variant's id suffix names it.
pub(super) fn level(suffix: &str) -> Option<ReasoningLevel> {
    Some(match suffix {
        "low" => ReasoningLevel::Low,
        "medium" => ReasoningLevel::Medium,
        "high" => ReasoningLevel::High,
        "xhigh" => ReasoningLevel::XHigh,
        "max" => ReasoningLevel::Max,
        _ => return None,
    })
}

/// A level as `thought_level` takes it.
pub(super) fn level_id(level: ReasoningLevel) -> &'static str {
    match level {
        ReasoningLevel::Low => "low",
        ReasoningLevel::Medium => "medium",
        ReasoningLevel::High => "high",
        ReasoningLevel::XHigh => "xhigh",
        ReasoningLevel::Max => "max",
    }
}

/// `level` if the model offers it, else the next higher it does, else its
/// highest.
pub(super) fn closest_level(levels: &[ReasoningLevel], level: ReasoningLevel) -> Option<ReasoningLevel> {
    levels
        .iter()
        .copied()
        .find(|l| *l >= level)
        .or_else(|| levels.last().copied())
}

/// `agy models`' lines (`id<TAB>Name (Level)`), in its order. Variants that
/// differ only by a level suffix fold into one model; a lone id ending in
/// one (`gpt-oss-120b-medium`) stays whole, as sessions list it.
pub(super) fn parse(text: &str) -> Models {
    let rows: Vec<(&str, &str)> = text
        .lines()
        .filter_map(|line| {
            let (id, name) = line.split_once('\t')?;
            let id = id.trim();
            (!id.is_empty() && !id.contains(' ')).then_some((id, name.trim()))
        })
        .collect();
    let split = |id: &str| -> Option<(String, ReasoningLevel)> {
        let (family, suffix) = id.rsplit_once('-')?;
        Some((family.to_owned(), level(suffix)?))
    };
    let siblings = |family: &str| rows.iter().filter(|(id, _)| split(id).is_some_and(|(f, _)| f == family)).count();

    let mut out = Models::default();
    for (id, name) in &rows {
        let (family, level) = match split(id) {
            Some((family, level)) if siblings(&family) > 1 => (family, Some(level)),
            _ => ((*id).to_owned(), None),
        };
        if let Some(model) = out.models.iter_mut().find(|m| m.id == family) {
            if let Some(level) = level
                && !model.reasoning_levels.contains(&level)
            {
                model.reasoning_levels.push(level);
                model.reasoning_levels.sort();
            }
            continue;
        }
        let label = match level {
            // "Gemini 3.8 Flash (High)" names the family "Gemini 3.8 Flash".
            Some(_) => name.rsplit_once(" (").map_or(*name, |(base, _)| base),
            None => name,
        };
        out.models.push(Model {
            id: family,
            label: if label.is_empty() { (*id).to_owned() } else { label.to_owned() },
            description: None,
            reasoning_levels: level.into_iter().collect(),
            options: Vec::new(),
        });
    }
    out.default = out.models.first().map(|m| m.id.clone());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const LISTED: &str = "Fetching available models...\n\
        gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\n\
        gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)\n\
        gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)\n\
        gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)\n\
        gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n\
        gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n\
        claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n\
        gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n";

    #[test]
    fn variants_fold_into_families_with_levels() {
        use ReasoningLevel::*;
        let models = parse(LISTED);
        let ids: Vec<&str> = models.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            ["gemini-4-hydrogen", "gemini-3.8-flash", "claude-sonnet-4-6", "gpt-oss-120b-medium"]
        );
        assert_eq!(models.default.as_deref(), Some("gemini-4-hydrogen"));
        let hydrogen = models.get("gemini-4-hydrogen").unwrap();
        assert_eq!(hydrogen.label, "Gemini 4 Hydrogen");
        assert_eq!(hydrogen.reasoning_levels, [Low, Medium, High, XHigh]);
        assert_eq!(models.get("gemini-3.8-flash").unwrap().reasoning_levels, [Low, High]);
        let gpt = models.get("gpt-oss-120b-medium").unwrap();
        assert_eq!(gpt.label, "GPT-OSS 120B (Medium)");
        assert!(gpt.reasoning_levels.is_empty());
        assert_eq!(models.get("claude-sonnet-4-6").unwrap().label, "Claude Sonnet 4.6 (Thinking)");
    }

    #[test]
    fn levels_fit_to_the_closest_offered() {
        use ReasoningLevel::*;
        assert_eq!(closest_level(&[Low, High], Medium), Some(High));
        assert_eq!(closest_level(&[Low, High], Max), Some(High));
        assert_eq!(closest_level(&[], Max), None);
    }
}
