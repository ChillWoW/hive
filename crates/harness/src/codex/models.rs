//! Codex's models. The list depends on the account, so it comes from the
//! CLI: `model/list` on an app-server (kept [`TTL`], refreshed in the
//! background), and until that answers, the CLI's own cache
//! (`$CODEX_HOME/models_cache.json`), read without starting anything.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use outcode_proto::{ChatConfig, Model, ModelOption, ModelOptionChoice, ReasoningLevel};
use serde_json::{Value, json};

use super::rpc::Server;
use crate::cli;

/// How long a `model/list` answer is used before it's asked again.
const TTL: Duration = Duration::from_secs(10 * 60);
const LIST_TIMEOUT: Duration = Duration::from_secs(30);

/// Codex's service tier that fast mode picks.
pub(super) const FAST_TIER: &str = "fast";

/// The models and which one is the default.
#[derive(Debug, Clone, Default, PartialEq)]
pub(super) struct Models {
    pub models: Vec<Model>,
    pub default: Option<String>,
}

impl Models {
    pub(super) fn get(&self, id: &str) -> Option<&Model> {
        self.models.iter().find(|m| m.id == id)
    }
}

/// The last `model/list` answer, shared by every run.
#[derive(Clone, Default)]
pub(super) struct Cache(Arc<Mutex<CacheState>>);

#[derive(Default)]
struct CacheState {
    listed: Option<(Instant, Models)>,
    refreshing: bool,
}

impl Cache {
    /// The models as last listed, else as the CLI's own cache has them.
    pub(super) fn models(&self) -> Option<Models> {
        let listed = self.0.lock().unwrap().listed.as_ref().map(|(_, m)| m.clone());
        listed.or_else(from_cache)
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
                Err(error) => eprintln!("[codex] listing models: {error}"),
            }
        });
    }
}

/// Every page of `model/list`.
async fn list(exe: &Path) -> Result<Models, String> {
    let work = async {
        let server = Server::start(exe, None).await.map_err(|e| e.to_string())?;
        let mut data = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let result = server.client.request("model/list", json!({ "cursor": cursor })).await?;
            data.extend(result["data"].as_array().cloned().unwrap_or_default());
            cursor = result["nextCursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        let Server { client, mut child, .. } = server;
        drop(client);
        tokio::spawn(async move { super::rpc::retire(&mut child).await });
        Ok(from_list(&data))
    };
    tokio::time::timeout(LIST_TIMEOUT, work)
        .await
        .map_err(|_| "codex didn't list its models".to_owned())?
}

/// A `model/list` answer's `data`.
pub(super) fn from_list(data: &[Value]) -> Models {
    let mut out = Models::default();
    for entry in data {
        if entry["hidden"].as_bool() == Some(true) {
            continue;
        }
        let Some(id) = str_field(entry, "id").or_else(|| str_field(entry, "model")) else {
            continue;
        };
        let efforts = entry["supportedReasoningEfforts"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter_map(|e| str_field(e, "reasoningEffort"));
        if entry["isDefault"].as_bool() == Some(true) {
            out.default = Some(id.to_owned());
        }
        out.models.push(model(
            id,
            str_field(entry, "displayName"),
            str_field(entry, "description"),
            efforts,
            &entry["serviceTiers"],
        ));
    }
    if out.default.is_none() {
        out.default = out.models.first().map(|m| m.id.clone());
    }
    out
}

/// The CLI's cache file: listed models, by its priority (the first is the
/// default, as `model/list` reports it).
pub(super) fn from_cache() -> Option<Models> {
    let text = std::fs::read_to_string(codex_home()?.join("models_cache.json")).ok()?;
    parse_cache(&serde_json::from_str(&text).ok()?)
}

fn parse_cache(json: &Value) -> Option<Models> {
    let mut entries: Vec<&Value> = json["models"]
        .as_array()?
        .iter()
        .filter(|m| str_field(m, "visibility") == Some("list"))
        .collect();
    entries.sort_by_key(|m| m["priority"].as_i64().unwrap_or(i64::MAX));
    let models: Vec<Model> = entries
        .iter()
        .filter_map(|m| {
            let efforts = m["supported_reasoning_levels"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .filter_map(|e| str_field(e, "effort"));
            Some(model(
                str_field(m, "slug")?,
                str_field(m, "display_name"),
                str_field(m, "description"),
                efforts,
                &m["service_tiers"],
            ))
        })
        .collect();
    (!models.is_empty()).then(|| Models {
        default: models.first().map(|m| m.id.clone()),
        models,
    })
}

/// `$CODEX_HOME`, else `~/.codex`.
fn codex_home() -> Option<PathBuf> {
    match std::env::var_os("CODEX_HOME").filter(|d| !d.is_empty()) {
        Some(dir) => Some(dir.into()),
        None => Some(cli::home_dir()?.join(".codex")),
    }
}

fn model<'a>(
    id: &str,
    label: Option<&str>,
    description: Option<&str>,
    efforts: impl Iterator<Item = &'a str>,
    tiers: &Value,
) -> Model {
    let mut reasoning_levels: Vec<ReasoningLevel> = efforts.filter_map(level).collect();
    reasoning_levels.sort();
    reasoning_levels.dedup();
    let fast = tiers
        .as_array()
        .is_some_and(|tiers| tiers.iter().any(|t| str_field(t, "id") == Some(FAST_TIER)));
    Model {
        id: id.to_owned(),
        label: label.filter(|l| !l.is_empty()).unwrap_or(id).to_owned(),
        description: description.filter(|d| !d.is_empty()).map(str::to_owned),
        reasoning_levels,
        options: if fast { vec![fast_mode_option()] } else { Vec::new() },
    }
}

/// Fast mode: Codex's `fast` service tier.
fn fast_mode_option() -> ModelOption {
    let choice = |id: &str, label: &str| ModelOptionChoice {
        id: id.into(),
        label: label.into(),
    };
    ModelOption {
        id: ChatConfig::FAST_MODE.into(),
        label: "Fast mode".into(),
        choices: vec![choice("off", "Off"), choice("on", "On")],
        default_choice: "off".into(),
    }
}

/// A Codex reasoning effort as a level; `none`, `minimal` and the like have
/// none.
fn level(effort: &str) -> Option<ReasoningLevel> {
    match effort {
        "low" => Some(ReasoningLevel::Low),
        "medium" => Some(ReasoningLevel::Medium),
        "high" => Some(ReasoningLevel::High),
        "xhigh" => Some(ReasoningLevel::XHigh),
        "max" => Some(ReasoningLevel::Max),
        _ => None,
    }
}

/// A level as Codex's effort.
pub(super) fn effort(level: ReasoningLevel) -> &'static str {
    match level {
        ReasoningLevel::Low => "low",
        ReasoningLevel::Medium => "medium",
        ReasoningLevel::High => "high",
        ReasoningLevel::XHigh => "xhigh",
        ReasoningLevel::Max => "max",
    }
}

/// `level` if offered, else the next higher one offered, else the highest;
/// `None` (the model's default) when it offers none. `offered` is sorted.
pub(super) fn closest_level(offered: &[ReasoningLevel], level: ReasoningLevel) -> Option<ReasoningLevel> {
    offered
        .iter()
        .copied()
        .find(|l| *l >= level)
        .or_else(|| offered.last().copied())
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_visible_models_with_their_levels() {
        let data = json!([
            {"id": "gpt-6-luna", "displayName": "GPT-6-Luna", "description": "Fast", "hidden": false,
             "supportedReasoningEfforts": [{"reasoningEffort": "low"}, {"reasoningEffort": "ultra"}, {"reasoningEffort": "max"}],
             "isDefault": true, "serviceTiers": [{"id": "fast", "name": "Fast", "description": ""}]},
            {"id": "secret", "displayName": "S", "hidden": true, "supportedReasoningEfforts": [], "isDefault": false, "serviceTiers": []},
        ]);
        let models = from_list(data.as_array().unwrap());
        assert_eq!(models.default.as_deref(), Some("gpt-6-luna"));
        assert_eq!(models.models.len(), 1);
        let m = &models.models[0];
        assert_eq!(m.reasoning_levels, [ReasoningLevel::Low, ReasoningLevel::Max]);
        assert_eq!(m.options[0].id, ChatConfig::FAST_MODE);
    }

    #[test]
    fn the_cli_cache_lists_by_priority() {
        let json = json!({"models": [
            {"slug": "b", "display_name": "B", "visibility": "list", "priority": 2, "supported_reasoning_levels": [{"effort": "high"}], "service_tiers": []},
            {"slug": "h", "visibility": "hide", "priority": 0},
            {"slug": "a", "display_name": "A", "visibility": "list", "priority": 1, "supported_reasoning_levels": [], "service_tiers": []},
        ]});
        let models = parse_cache(&json).unwrap();
        assert_eq!(models.default.as_deref(), Some("a"));
        assert_eq!(models.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(models.get("b").unwrap().reasoning_levels, [ReasoningLevel::High]);
    }

    #[test]
    fn levels_snap_to_what_is_offered() {
        use ReasoningLevel::*;
        assert_eq!(closest_level(&[Low, Medium, High], Medium), Some(Medium));
        assert_eq!(closest_level(&[Medium, High], Low), Some(Medium));
        assert_eq!(closest_level(&[Low, Medium], Max), Some(Medium));
        assert_eq!(closest_level(&[], High), None);
    }
}
