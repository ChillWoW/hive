//! OpenCode's models, from `GET /api/model` (2.x): every enabled chat model
//! of the providers the user has set up, as `providerID/modelID`. Reasoning
//! levels are the model's variants that name one (`low`, `high`, …).

use std::collections::HashMap;

use hive_proto::{Model, ReasoningLevel};
use serde_json::Value;

#[derive(Debug, Clone, Default)]
pub(super) struct Models {
    pub models: Vec<Model>,
    pub default: Option<String>,
    /// Context window by model id.
    pub windows: HashMap<String, u64>,
    /// Variant ids by model id, for picking one by reasoning level.
    pub variants: HashMap<String, Vec<String>>,
}

/// `list`: `/api/model`'s data; `providers`: `/api/provider`'s, for names;
/// `default`: `/api/model/default`'s.
pub(super) fn parse(list: &Value, providers: &Value, default: &Value) -> Models {
    let names: HashMap<&str, &str> = providers
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| Some((p["id"].as_str()?, p["name"].as_str()?)))
        .collect();
    let mut out = Models::default();
    for model in list.as_array().into_iter().flatten() {
        let (Some(provider), Some(id)) = (model["providerID"].as_str(), model["id"].as_str()) else {
            continue;
        };
        let usable = model["enabled"].as_bool() != Some(false)
            && model["status"].as_str() != Some("deprecated")
            && model["type"].as_str().is_none_or(|t| t == "chat");
        if !usable {
            continue;
        }
        let key = format!("{provider}/{id}");
        let variants: Vec<String> = model["variants"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v["id"].as_str().map(str::to_owned))
            .collect();
        let mut levels: Vec<ReasoningLevel> = variants.iter().filter_map(|v| level(v)).collect();
        levels.sort();
        levels.dedup();
        if let Some(window) = model["limit"]["context"].as_u64() {
            out.windows.insert(key.clone(), window);
        }
        out.models.push(Model {
            id: key.clone(),
            label: model["name"].as_str().unwrap_or(id).to_owned(),
            description: Some(names.get(provider).copied().unwrap_or(provider).to_owned()),
            reasoning_levels: levels,
            options: Vec::new(),
        });
        out.variants.insert(key, variants);
    }
    if let (Some(provider), Some(id)) = (default["providerID"].as_str(), default["id"].as_str()) {
        out.default = Some(format!("{provider}/{id}"));
    }
    out
}

fn level(variant: &str) -> Option<ReasoningLevel> {
    Some(match variant {
        "minimal" => ReasoningLevel::Minimal,
        "low" => ReasoningLevel::Low,
        "medium" => ReasoningLevel::Medium,
        "high" => ReasoningLevel::High,
        "xhigh" | "x-high" => ReasoningLevel::XHigh,
        "max" => ReasoningLevel::Max,
        _ => return None,
    })
}

/// The variant to run `level` with: the first of its spellings the model
/// offers, else the closest level it has.
pub(super) fn variant(variants: &[String], level: Option<ReasoningLevel>) -> Option<String> {
    let level = level?;
    let wanted: &[&str] = match level {
        ReasoningLevel::Minimal => &["minimal", "low"],
        ReasoningLevel::Low => &["low", "minimal"],
        ReasoningLevel::Medium => &["medium"],
        ReasoningLevel::High => &["high"],
        ReasoningLevel::XHigh => &["xhigh", "x-high", "high"],
        ReasoningLevel::Max => &["max", "xhigh", "x-high", "high"],
    };
    if let Some(found) = wanted.iter().find(|w| variants.iter().any(|v| v == *w)) {
        return Some((*found).to_owned());
    }
    // The next level up the model has, else its highest.
    let mut offered: Vec<(ReasoningLevel, &String)> =
        variants.iter().filter_map(|v| Some((self::level(v)?, v))).collect();
    offered.sort();
    offered
        .iter()
        .find(|(l, _)| *l >= level)
        .or(offered.last())
        .map(|(_, v)| (*v).clone())
}

/// `providerID/modelID` → its parts; the model id may itself hold slashes.
pub(super) fn split(id: &str) -> Option<(&str, &str)> {
    id.split_once('/').filter(|(p, m)| !p.is_empty() && !m.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lists_usable_chat_models() {
        let list = json!([
            { "id": "particle-ai/particle-1", "providerID": "openrouter", "name": "Particle-1", "type": "chat",
              "variants": [{ "id": "none" }, { "id": "low" }, { "id": "max" }], "limit": { "context": 1000 }, "enabled": true },
            { "id": "img", "providerID": "openai", "name": "Image", "type": "image" },
            { "id": "off", "providerID": "openai", "name": "Off", "enabled": false },
        ]);
        let providers = json!([{ "id": "openrouter", "name": "OpenRouter" }]);
        let models = parse(&list, &providers, &json!({ "providerID": "openrouter", "id": "particle-ai/particle-1" }));
        assert_eq!(models.models.len(), 1);
        let m = &models.models[0];
        assert_eq!(m.id, "openrouter/particle-ai/particle-1");
        assert_eq!(m.description.as_deref(), Some("OpenRouter"));
        assert_eq!(m.reasoning_levels, [ReasoningLevel::Low, ReasoningLevel::Max]);
        assert_eq!(models.windows[&m.id], 1000);
        assert_eq!(models.default.as_deref(), Some(m.id.as_str()));
        assert_eq!(split(&m.id), Some(("openrouter", "particle-ai/particle-1")));
    }

    #[test]
    fn picks_a_variant_the_model_has() {
        let v: Vec<String> = ["low", "high"].map(String::from).to_vec();
        assert_eq!(variant(&v, Some(ReasoningLevel::Minimal)).as_deref(), Some("low"));
        assert_eq!(variant(&v, Some(ReasoningLevel::Medium)).as_deref(), Some("high"));
        assert_eq!(variant(&v, Some(ReasoningLevel::Max)).as_deref(), Some("high"));
        assert_eq!(variant(&v, None), None);
        assert_eq!(variant(&[], Some(ReasoningLevel::Low)), None);
    }
}
