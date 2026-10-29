//! The CLI's commands, split into commands and skills, as in zeron: `/name`
//! runs a command at the start of a prompt, `$name` names a skill anywhere.
//!
//! The `initialize` response lists every command (skills included) but
//! doesn't say which are skills; each turn's `system:init` does (`skills`).
//! The last list seen is kept for the harness's later runs. Before any, a
//! command the CLI doesn't mark `builtin` is taken for a skill: user, project
//! and plugin entries all are.

use std::collections::HashSet;

use hive_proto::{CommandKind, SlashCommand};
use serde_json::Value;

/// One entry of the CLI's command list.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Advertised {
    command: SlashCommand,
    aliases: Vec<String>,
    builtin: bool,
}

impl Advertised {
    fn names(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.command.name.as_str()).chain(self.aliases.iter().map(String::as_str))
    }
}

/// The commands in an `initialize` response or `commands_changed` frame.
pub(crate) fn parse(commands: &[Value]) -> Vec<Advertised> {
    commands
        .iter()
        .filter_map(|c| {
            let name = c.get("name").and_then(Value::as_str)?;
            Some(Advertised {
                command: SlashCommand {
                    name: name.trim_start_matches('/').into(),
                    description: c
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .into(),
                    input_hint: c
                        .get("argumentHint")
                        .and_then(Value::as_str)
                        .filter(|h| !h.is_empty())
                        .map(Into::into),
                    kind: CommandKind::Command,
                },
                aliases: c
                    .get("aliases")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|a| a.trim_start_matches('/').to_owned())
                    .collect(),
                builtin: c.get("builtin").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .collect()
}

/// Each command with its kind: by `skills` (a `system:init`'s list) when
/// known, else by whether it's built in.
pub(crate) fn classify(
    advertised: &[Advertised],
    skills: Option<&HashSet<String>>,
) -> Vec<SlashCommand> {
    advertised
        .iter()
        .map(|a| {
            let skill = match skills {
                Some(skills) => a.names().any(|n| skills.contains(n)),
                None => !a.builtin,
            };
            SlashCommand {
                kind: if skill {
                    CommandKind::Skill
                } else {
                    CommandKind::Command
                },
                ..a.command.clone()
            }
        })
        .collect()
}

/// Every name (aliases too) a skill among `advertised` answers to.
pub(crate) fn skill_names(
    advertised: &[Advertised],
    skills: Option<&HashSet<String>>,
) -> HashSet<String> {
    let mut names: HashSet<String> = advertised
        .iter()
        .zip(classify(advertised, skills))
        .filter(|(_, c)| c.kind == CommandKind::Skill)
        .flat_map(|(a, _)| a.names().map(str::to_owned).collect::<Vec<_>>())
        .collect();
    names.extend(skills.into_iter().flatten().cloned());
    names
}

fn name_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '-' | '_' | ':' | '.')
}

/// The prompt as Claude takes it: a skill named first (`$name`) becomes its
/// command (`/name`), one named later "the /name skill". Only names in
/// `skills` count, so `$HOME` or `$5` stay as typed; code (between
/// backticks) is left alone.
pub(crate) fn skill_prompt(prompt: &str, skills: &HashSet<String>) -> String {
    if !prompt.contains('$') || skills.is_empty() {
        return prompt.to_owned();
    }
    let mut out = String::with_capacity(prompt.len() + 16);
    let mut fenced = false;
    let mut leading = true;
    for line in prompt.split_inclusive('\n') {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            out.push_str(line);
            leading &= line.trim().is_empty();
            continue;
        }
        if fenced {
            out.push_str(line);
            continue;
        }
        let mut code = false;
        let mut prev: Option<char> = None;
        let mut rest = line;
        while let Some(c) = rest.chars().next() {
            if c == '`' {
                code = !code;
            }
            let boundary = prev.is_none_or(|p| p.is_whitespace() || matches!(p, '(' | '[' | '{'));
            if c == '$' && !code && boundary {
                let after = &rest[1..];
                let end = after.find(|c: char| !name_char(c)).unwrap_or(after.len());
                // Trailing punctuation ends the sentence, not the name.
                let name = after[..end].trim_end_matches(['.', ':']);
                if !name.starts_with(|c: char| c.is_numeric()) && skills.contains(name) {
                    if leading {
                        out.push('/');
                        out.push_str(name);
                    } else {
                        out.push_str("the /");
                        out.push_str(name);
                        out.push_str(" skill");
                    }
                    leading = false;
                    prev = name.chars().last();
                    rest = &after[name.len()..];
                    continue;
                }
            }
            if !c.is_whitespace() {
                leading = false;
            }
            out.push(c);
            prev = Some(c);
            rest = &rest[c.len_utf8()..];
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn listed() -> Vec<Advertised> {
        parse(&[
            json!({"name": "compact", "description": "Free up context", "argumentHint": "<instructions>", "builtin": true}),
            json!({"name": "code-review", "description": "Review the diff", "aliases": ["review"], "builtin": true}),
            json!({"name": "find-skills", "description": "Find skills", "argumentHint": ""}),
            json!({"name": "docs", "description": "Docs", "aliases": ["anthropic-skills:docs"]}),
        ])
    }

    fn kinds(commands: &[SlashCommand]) -> Vec<(&str, CommandKind)> {
        commands.iter().map(|c| (c.name.as_str(), c.kind)).collect()
    }

    #[test]
    fn unmarked_commands_are_skills_until_the_cli_lists_them() {
        use CommandKind::*;
        let commands = classify(&listed(), None);
        assert_eq!(
            kinds(&commands),
            [
                ("compact", Command),
                ("code-review", Command),
                ("find-skills", Skill),
                ("docs", Skill)
            ]
        );
        assert_eq!(commands[0].input_hint.as_deref(), Some("<instructions>"));
        assert_eq!(commands[2].input_hint, None);

        // `system:init`'s list names a built-in skill, and a plugin's by alias.
        let skills: HashSet<String> = ["code-review", "find-skills", "anthropic-skills:docs"]
            .map(String::from)
            .into();
        assert_eq!(
            kinds(&classify(&listed(), Some(&skills))),
            [
                ("compact", Command),
                ("code-review", Skill),
                ("find-skills", Skill),
                ("docs", Skill)
            ]
        );
        let names = skill_names(&listed(), Some(&skills));
        assert!(names.contains("review") && names.contains("docs") && !names.contains("compact"));
    }

    #[test]
    fn skills_become_commands_first_and_references_later() {
        let skills: HashSet<String> = ["simplify", "pdf"].map(String::from).into();
        let cases = [
            ("$simplify the parser", "/simplify the parser"),
            ("  $simplify", "  /simplify"),
            (
                "tidy this with $simplify.",
                "tidy this with the /simplify skill.",
            ),
            ("$simplify then $pdf", "/simplify then the /pdf skill"),
            ("costs $5 and $HOME", "costs $5 and $HOME"),
            ("`$simplify` stays", "`$simplify` stays"),
            (
                "```\n$simplify\n```\n$pdf",
                "```\n$simplify\n```\nthe /pdf skill",
            ),
            ("a$simplify", "a$simplify"),
            ("($pdf)", "(the /pdf skill)"),
            ("$simplifyx", "$simplifyx"),
        ];
        for (prompt, sent) in cases {
            assert_eq!(skill_prompt(prompt, &skills), sent, "{prompt:?}");
        }
    }
}
