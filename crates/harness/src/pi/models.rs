//! Pi's models, from `get_available_models`: `provider/id`, with the
//! reasoning levels Pi itself would offer (its `getSupportedThinkingLevels`).

use hive_proto::{Model, ModelOption, ReasoningLevel};
use serde_json::Value;

use crate::models::{choice, level};

/// The model option turning thinking off, on models that can.
pub(crate) const THINKING: &str = "thinking";

#[derive(Debug, Clone, Default)]
pub(crate) struct Models {
    pub models: Vec<Model>,
    /// Pi's own default (`provider/id`), as `get_state` names it.
    pub default: Option<String>,
}

/// `provider/id`, as Hive names a Pi model.
pub(crate) fn model_id(model: &Value) -> Option<String> {
    let provider = model.get("provider")?.as_str()?;
    let id = model.get("id")?.as_str()?;
    Some(format!("{provider}/{id}"))
}

/// A `get_available_models` answer's models, in Pi's order.
pub(crate) fn parse(data: &Value) -> Vec<Model> {
    data["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = model_id(m)?;
            let thinking = thinking_levels(m);
            let mut options = Vec::new();
            if thinking.contains(&"off") && thinking.len() > 1 {
                options.push(ModelOption {
                    id: THINKING.into(),
                    label: "Thinking".into(),
                    choices: vec![choice("on", "On"), choice("off", "Off")],
                    default_choice: "on".into(),
                });
            }
            Some(Model {
                label: m["name"].as_str().unwrap_or(&id).to_owned(),
                description: m["provider"].as_str().map(str::to_owned),
                reasoning_levels: thinking.iter().filter_map(|l| level(l)).collect(),
                options,
                id,
            })
        })
        .collect()
}

/// The thinking levels Pi offers for `model`, `off` included: none past
/// `off` without reasoning; a level its `thinkingLevelMap` maps to null is
/// out, and `xhigh` / `max` only when the map names them.
pub(crate) fn thinking_levels(model: &Value) -> Vec<&'static str> {
    if model["reasoning"].as_bool() != Some(true) {
        return vec!["off"];
    }
    let map = &model["thinkingLevelMap"];
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        .into_iter()
        .filter(|l| match map.get(*l) {
            Some(Value::Null) => false,
            Some(_) => true,
            None => !matches!(*l, "xhigh" | "max"),
        })
        .collect()
}

/// The level to set for a run: off when the model option says so, else the
/// picked level, else none (Pi's own default).
pub(crate) fn thinking_for(
    reasoning: Option<ReasoningLevel>,
    options: &std::collections::BTreeMap<String, String>,
) -> Option<&'static str> {
    if options.get(THINKING).map(String::as_str) == Some("off") {
        return Some("off");
    }
    reasoning.map(crate::models::level_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn levels_follow_the_thinking_map() {
        let mapped = json!({"reasoning": true, "thinkingLevelMap": {"off": "none", "minimal": null, "medium": null, "max": "max"}});
        assert_eq!(thinking_levels(&mapped), ["off", "low", "high", "max"]);
        assert_eq!(thinking_levels(&json!({"reasoning": true})), ["off", "minimal", "low", "medium", "high"]);
        assert_eq!(thinking_levels(&json!({"reasoning": false})), ["off"]);
    }

    #[test]
    fn models_are_named_by_provider() {
        let models = parse(&json!({"models": [
            {"id": "m1", "name": "Model One", "provider": "p", "reasoning": true, "thinkingLevelMap": {"off": null}},
            {"id": "m2", "provider": "q", "reasoning": true},
        ]}));
        assert_eq!(models[0].id, "p/m1");
        assert_eq!(models[0].label, "Model One");
        assert!(models[0].options.is_empty());
        assert_eq!(models[1].label, "q/m2");
        assert_eq!(models[1].options[0].id, THINKING);
        assert_eq!(models[1].reasoning_levels.len(), 4);
    }
}
