//! Codex's skills (`skills/list`) and the commands the composer offers.
//! A `$name` in a prompt that names a skill also sends that skill as a
//! `skill` input, as the Codex TUI does.

use hive_proto::{CommandKind, SlashCommand};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: String,
}

/// The enabled skills in a `skills/list` answer.
pub fn parse(result: &Value) -> Vec<Skill> {
    let mut skills: Vec<Skill> = result["data"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .flat_map(|entry| {
            entry["skills"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
        })
        .filter(|s| s["enabled"].as_bool() != Some(false))
        .filter_map(|s| {
            let description = s["shortDescription"]
                .as_str()
                .filter(|d| !d.is_empty())
                .or_else(|| s["description"].as_str())
                .unwrap_or_default();
            Some(Skill {
                name: s["name"].as_str()?.to_owned(),
                description: first_sentence(description),
                path: s["path"].as_str()?.to_owned(),
            })
        })
        .collect();
    skills.dedup_by(|a, b| a.name == b.name);
    skills
}

/// The commands Hive runs itself, then the skills.
pub fn commands(skills: &[Skill]) -> Vec<SlashCommand> {
    let mut commands = builtin();
    commands.extend(skills.iter().map(|s| SlashCommand {
        name: s.name.clone(),
        description: s.description.clone(),
        input_hint: None,
        kind: CommandKind::Skill,
    }));
    commands
}

/// `/compact`, `/review`, `/goal` and `/feedback`, which the session turns
/// into their own app-server requests.
pub fn builtin() -> Vec<SlashCommand> {
    vec![
        SlashCommand {
            name: "goal".into(),
            description: "Set a goal Codex keeps working toward until it's done".into(),
            input_hint: Some("objective, or pause, resume, clear".into()),
            kind: CommandKind::Command,
        },
        SlashCommand {
            name: "compact".into(),
            description: "Summarize the conversation to free up context".into(),
            input_hint: None,
            kind: CommandKind::Command,
        },
        SlashCommand {
            name: "review".into(),
            description: "Review uncommitted changes, or what you describe".into(),
            input_hint: Some("instructions".into()),
            kind: CommandKind::Command,
        },
        SlashCommand {
            name: "feedback".into(),
            description: "Send this chat and Codex's logs to OpenAI".into(),
            input_hint: Some("what went wrong (optional)".into()),
            kind: CommandKind::Command,
        },
    ]
}

/// The skills a prompt names as `$name`.
pub fn mentioned<'a>(prompt: &str, skills: &'a [Skill]) -> Vec<&'a Skill> {
    let mut found: Vec<&Skill> = Vec::new();
    for (at, _) in prompt.match_indices('$') {
        if at > 0 && !prompt[..at].ends_with(char::is_whitespace) {
            continue;
        }
        let name: String = prompt[at + 1..]
            .chars()
            .take_while(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
            .collect();
        let name = name.trim_end_matches('.');
        if let Some(skill) = skills.iter().find(|s| s.name == name) {
            if !found.iter().any(|f| f.name == skill.name) {
                found.push(skill);
            }
        }
    }
    found
}

fn first_sentence(text: &str) -> String {
    let line = text.lines().next().unwrap_or_default().trim();
    match line.find(". ") {
        Some(end) => line[..=end].to_owned(),
        None => line.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lists_enabled_skills_and_finds_mentions() {
        let skills = parse(&json!({"data": [{"cwd": "/w", "skills": [
            {"name": "pdf", "description": "Work with PDFs. More text.", "path": "/s/pdf/SKILL.md", "enabled": true},
            {"name": "off", "description": "", "path": "/s/off", "enabled": false},
            {"name": "docs:write", "description": "d", "shortDescription": "Short", "path": "/s/dw", "enabled": true},
        ]}]}));
        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].description, "Work with PDFs.");
        assert_eq!(skills[1].description, "Short");
        let names: Vec<_> = mentioned("use $pdf and $docs:write. not a$pdf, $nope", &skills)
            .iter()
            .map(|s| s.name.as_str())
            .collect();
        assert_eq!(names, ["pdf", "docs:write"]);
        assert_eq!(commands(&skills)[builtin().len()].kind, CommandKind::Skill);
    }
}
