//! Claude's models, and the flags a chat's model config becomes.

use std::path::Path;

use outcode_proto::{Catalog, ChatConfig, Model, ModelOption, ModelOptionChoice, ReasoningLevel};
use serde_json::{Map, Value};

/// `--effort` levels, lowest first.
const EFFORTS: [ReasoningLevel; 5] = [
    ReasoningLevel::Low,
    ReasoningLevel::Medium,
    ReasoningLevel::High,
    ReasoningLevel::XHigh,
    ReasoningLevel::Max,
];

fn effort(level: ReasoningLevel) -> &'static str {
    match level {
        ReasoningLevel::Low => "low",
        ReasoningLevel::Medium => "medium",
        ReasoningLevel::High => "high",
        ReasoningLevel::XHigh => "xhigh",
        ReasoningLevel::Max => "max",
    }
}

fn model(id: &str, label: &str, description: &str, reasoning: &[ReasoningLevel]) -> Model {
    Model {
        id: id.into(),
        label: label.into(),
        description: Some(description.into()),
        reasoning_levels: reasoning.to_vec(),
        options: Vec::new(),
    }
}

fn choice(id: &str, label: &str) -> ModelOptionChoice {
    ModelOptionChoice {
        id: id.into(),
        label: label.into(),
    }
}

/// An Opus model: these take fast mode (Claude's `fastMode` setting).
fn opus(id: &str, label: &str, description: &str) -> Model {
    Model {
        options: vec![ModelOption {
            id: ChatConfig::FAST_MODE.into(),
            label: "Fast mode".into(),
            choices: vec![choice("off", "Off"), choice("on", "On")],
            default_choice: "off".into(),
        }],
        ..model(id, label, description, &EFFORTS)
    }
}

/// Claude's models by their full ids, curated: the current default first,
/// then newest to oldest per family. `binary` as for [`super::find`].
pub fn catalog(binary: Option<&Path>) -> Catalog {
    Catalog {
        installed: super::find(binary).is_ok(),
        models: vec![
            opus("claude-opus-5-5", "Opus 5.5", "Best for everyday, complex tasks"),
            model(
                "claude-fable-5-2",
                "Fable 5.2",
                "Most intelligent model for building agents",
                &EFFORTS,
            ),
            model(
                "claude-sonnet-5-5",
                "Sonnet 5.5",
                "Most efficient for simpler tasks",
                &EFFORTS,
            ),
            model("claude-haiku-5-5", "Haiku 5.5", "Fastest for quick answers", &EFFORTS),
            model("claude-fable-5-1", "Fable 5.1", "Previous generation Fable", &EFFORTS),
            opus("claude-opus-5", "Opus 5", "Previous generation Opus"),
            model("claude-sonnet-5", "Sonnet 5", "Previous generation Sonnet", &EFFORTS),
            model("claude-haiku-4-5", "Haiku 4.5", "Previous generation Haiku", &[]),
        ],
        default_model: Some("claude-opus-5-5".into()),
    }
}

/// `--model`, `--effort`, and fast mode as inline `--settings` layered over
/// the user's own (left out while off, so theirs stands).
pub(super) fn config_args(config: &ChatConfig) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(model) = config.model.as_deref().filter(|m| !m.is_empty()) {
        args.extend(["--model".into(), model.into()]);
    }
    if let Some(level) = config.reasoning {
        args.extend(["--effort".into(), effort(level).into()]);
    }
    if config.fast_mode() {
        let mut settings = Map::new();
        settings.insert("fastMode".into(), true.into());
        args.extend(["--settings".into(), Value::Object(settings).to_string()]);
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_config_becomes_flags() {
        assert!(config_args(&ChatConfig::default()).is_empty());
        let mut config = ChatConfig {
            model: Some("claude-opus-5-5".into()),
            reasoning: Some(ReasoningLevel::XHigh),
            ..ChatConfig::default()
        };
        config
            .model_options
            .insert(ChatConfig::FAST_MODE.into(), "on".into());
        assert_eq!(
            config_args(&config),
            [
                "--model",
                "claude-opus-5-5",
                "--effort",
                "xhigh",
                "--settings",
                r#"{"fastMode":true}"#
            ]
        );
    }

    #[test]
    fn only_opus_offers_fast_mode() {
        let catalog = catalog(Some(Path::new("/nowhere/claude")));
        assert!(!catalog.installed);
        for model in &catalog.models {
            assert_eq!(!model.options.is_empty(), model.id.starts_with("claude-opus-"));
        }
        let default = catalog.default_model.as_deref();
        assert!(catalog.models.iter().any(|m| Some(m.id.as_str()) == default));
    }
}
