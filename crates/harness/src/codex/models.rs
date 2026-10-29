//! Codex's models. The list depends on the account, so it comes from the
//! CLI: `model/list` on an app-server, and until that answers, the CLI's own
//! cache (`$CODEX_HOME/models_cache.json`), read without starting anything.

use std::path::PathBuf;

use hive_proto::{Model, ModelOption, ModelOptionChoice, ReasoningLevel};
use serde_json::Value;

/// The model option for Codex's fast service tier.
pub const FAST_MODE: &str = "fastMode";
/// The model option for any other service tiers a model offers.
pub const SERVICE_TIER: &str = "serviceTier";

/// The models and which one is the default.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Models {
    pub models: Vec<Model>,
    pub default: Option<String>,
}

/// A `model/list` answer's `data`.
pub fn from_list(data: &[Value]) -> Models {
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
    out
}

/// The CLI's cache file: listed models, by its priority (the first is the
/// default, as `model/list` reports it).
pub fn from_cache() -> Option<Models> {
    let text = std::fs::read_to_string(codex_home()?.join("models_cache.json")).ok()?;
    let json: Value = serde_json::from_str(&text).ok()?;
    let mut entries: Vec<&Value> = json["models"]
        .as_array()?
        .iter()
        .filter(|m| str_field(m, "visibility") == Some("list"))
        .collect();
    entries.sort_by_key(|m| m["priority"].as_i64().unwrap_or(i64::MAX));
    let models: Vec<Model> = entries
        .iter()
        .filter_map(|m| {
            let id = str_field(m, "slug")?;
            let efforts = m["supported_reasoning_levels"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .filter_map(|e| str_field(e, "effort"));
            Some(model(
                id,
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
pub fn codex_home() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CODEX_HOME").filter(|d| !d.is_empty()) {
        return Some(dir.into());
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    Some(PathBuf::from(home).join(".codex"))
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
    Model {
        id: id.to_owned(),
        label: label.filter(|l| !l.is_empty()).unwrap_or(id).to_owned(),
        description: description.filter(|d| !d.is_empty()).map(str::to_owned),
        reasoning_levels,
        options: tier_options(tiers),
    }
}

/// A `fast` tier is the composer's Fast mode switch; other tiers are a
/// choice of their own.
fn tier_options(tiers: &Value) -> Vec<ModelOption> {
    let tiers: Vec<(&str, &str)> = tiers
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|t| {
            let id = str_field(t, "id")?;
            Some((
                id,
                str_field(t, "name").filter(|n| !n.is_empty()).unwrap_or(id),
            ))
        })
        .collect();
    let choice = |id: &str, label: &str| ModelOptionChoice {
        id: id.into(),
        label: label.into(),
    };
    let mut options = Vec::new();
    if tiers.iter().any(|(id, _)| *id == "fast") {
        options.push(ModelOption {
            id: FAST_MODE.into(),
            label: "Fast mode".into(),
            choices: vec![choice("off", "Off"), choice("on", "On")],
            default_choice: "off".into(),
        });
    }
    let others: Vec<_> = tiers.iter().filter(|(id, _)| *id != "fast").collect();
    if !others.is_empty() {
        let mut choices = vec![choice("default", "Default")];
        choices.extend(others.iter().map(|(id, name)| choice(id, name)));
        options.push(ModelOption {
            id: SERVICE_TIER.into(),
            label: "Service tier".into(),
            choices,
            default_choice: "default".into(),
        });
    }
    options
}

/// A Codex effort as a level; ones Hive has no level for are left out.
fn level(effort: &str) -> Option<ReasoningLevel> {
    Some(match effort {
        "minimal" => ReasoningLevel::Minimal,
        "low" => ReasoningLevel::Low,
        "medium" => ReasoningLevel::Medium,
        "high" => ReasoningLevel::High,
        "xhigh" => ReasoningLevel::XHigh,
        "max" => ReasoningLevel::Max,
        _ => return None,
    })
}

/// `level` if offered, else the next higher one offered, else the highest;
/// `None` (the model's default) when it offers none. `offered` is sorted.
pub fn closest_level(offered: &[ReasoningLevel], level: ReasoningLevel) -> Option<ReasoningLevel> {
    offered
        .iter()
        .copied()
        .find(|l| *l >= level)
        .or_else(|| offered.last().copied())
}

/// A level as Codex's effort.
pub fn effort(level: ReasoningLevel) -> &'static str {
    match level {
        ReasoningLevel::Minimal => "minimal",
        ReasoningLevel::Low => "low",
        ReasoningLevel::Medium => "medium",
        ReasoningLevel::High => "high",
        ReasoningLevel::XHigh => "xhigh",
        ReasoningLevel::Max => "max",
    }
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
        assert_eq!(
            m.reasoning_levels,
            [ReasoningLevel::Low, ReasoningLevel::Max]
        );
        assert_eq!(m.options[0].id, FAST_MODE);
    }

    #[test]
    fn levels_snap_to_what_is_offered() {
        use ReasoningLevel::*;
        assert_eq!(closest_level(&[Low, Medium, High], Minimal), Some(Low));
        assert_eq!(closest_level(&[Low, Medium, High], Medium), Some(Medium));
        assert_eq!(closest_level(&[Low, Medium], Max), Some(Medium));
        assert_eq!(closest_level(&[], High), None);
    }
}
