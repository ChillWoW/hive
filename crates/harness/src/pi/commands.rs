//! Pi's commands (`get_commands`): extension commands and prompt templates
//! as `/name`, skills (`skill:name`) as `$name`, which a prompt starting with
//! one sends as Pi's `/skill:name`.

use hive_proto::{CommandKind, SlashCommand};
use serde_json::Value;

/// Pi's own commands over RPC: `/compact` (its `compact` command).
pub(super) fn builtin() -> Vec<SlashCommand> {
    vec![crate::compact_command()]
}

/// The built-in commands, then the listed ones without repeats.
pub(super) fn with_builtins(listed: &[SlashCommand]) -> Vec<SlashCommand> {
    let mut commands = builtin();
    for command in listed {
        if !commands.iter().any(|c| c.name == command.name) {
            commands.push(command.clone());
        }
    }
    commands
}

/// A `get_commands` answer.
pub(super) fn parse(data: &Value) -> Vec<SlashCommand> {
    data["commands"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let name = c["name"].as_str()?;
            let skill = c["source"] == "skill";
            Some(SlashCommand {
                name: if skill {
                    name.strip_prefix("skill:").unwrap_or(name).to_owned()
                } else {
                    name.to_owned()
                },
                description: c["description"].as_str().unwrap_or_default().to_owned(),
                input_hint: None,
                kind: if skill {
                    CommandKind::Skill
                } else {
                    CommandKind::Command
                },
            })
        })
        .collect()
}

pub(super) fn skill_names(commands: &[SlashCommand]) -> Vec<String> {
    commands
        .iter()
        .filter(|c| c.kind == CommandKind::Skill)
        .map(|c| c.name.clone())
        .collect()
}

/// `$skill` as Pi takes it: leading, its `/skill:name` command (expanded
/// by Pi); later ones named in words, the model finding them listed in
/// its system prompt.
pub(super) fn skill_prompt(prompt: &str, skills: &[String]) -> String {
    let mut out = String::with_capacity(prompt.len());
    let mut first = true;
    let mut rest = prompt;
    while let Some(at) = rest.find('$') {
        let (before, after) = rest.split_at(at);
        out.push_str(before);
        let name_len = after[1..]
            .find(|c: char| c.is_whitespace())
            .unwrap_or(after.len() - 1);
        let name = &after[1..1 + name_len];
        let starts_word = out.is_empty() || out.ends_with(char::is_whitespace);
        if starts_word && skills.iter().any(|s| s == name) {
            if first && out.trim().is_empty() {
                out.push_str(&format!("/skill:{name}"));
            } else {
                out.push_str(&format!("the {name} skill"));
            }
        } else {
            out.push_str(&after[..1 + name_len]);
        }
        first = false;
        rest = &after[1 + name_len..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn skills_are_told_apart() {
        let listed = parse(&json!({"commands": [
            {"name": "fix", "description": "Fix it", "source": "prompt"},
            {"name": "skill:review", "source": "skill"},
        ]}));
        assert_eq!(listed[0].kind, CommandKind::Command);
        assert_eq!(listed[1].name, "review");
        assert_eq!(listed[1].kind, CommandKind::Skill);
        assert_eq!(with_builtins(&listed)[0].name, "compact");
    }

    #[test]
    fn skills_in_prompts() {
        let skills = vec!["review".to_owned()];
        assert_eq!(skill_prompt("$review the diff", &skills), "/skill:review the diff");
        assert_eq!(skill_prompt("use $review now", &skills), "use the review skill now");
        assert_eq!(skill_prompt("costs $5 and $other", &skills), "costs $5 and $other");
    }
}
