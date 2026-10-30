//! `/goal` and `/feedback`: Codex commands Hive runs over app-server RPCs
//! (`thread/goal/*`, `feedback/upload`) rather than as a model turn, as
//! t3code does.

use hive_proto::{Goal, GoalStatus};
use serde_json::Value;

/// What a `/goal` prompt asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GoalCommand {
    /// `/goal` (or `/goal edit`): what's set now.
    Show,
    Clear,
    Pause,
    Resume,
    /// `/goal <objective>`: replaces any goal and starts on it.
    Set(String),
}

/// `/goal …` on its own; `None` for any other prompt.
pub fn parse_goal(text: &str) -> Option<GoalCommand> {
    let rest = text.trim().strip_prefix("/goal")?;
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let arg = rest.trim();
    Some(match arg.to_lowercase().as_str() {
        "" | "edit" | "show" => GoalCommand::Show,
        "clear" => GoalCommand::Clear,
        "pause" => GoalCommand::Pause,
        "resume" => GoalCommand::Resume,
        _ => GoalCommand::Set(arg.to_owned()),
    })
}

/// `/feedback [reason]` on its own: the reason, possibly empty.
pub fn parse_feedback(text: &str) -> Option<String> {
    let rest = text.trim().strip_prefix("/feedback")?;
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return None;
    }
    Some(rest.trim().to_owned())
}

/// A `ThreadGoal` off the wire.
pub fn goal(value: &Value) -> Option<Goal> {
    let objective = value["objective"].as_str()?.to_owned();
    let status = match value["status"].as_str()? {
        "active" => GoalStatus::Active,
        "paused" => GoalStatus::Paused,
        "blocked" => GoalStatus::Blocked,
        "usageLimited" => GoalStatus::UsageLimited,
        "budgetLimited" => GoalStatus::BudgetLimited,
        "complete" => GoalStatus::Complete,
        _ => return None,
    };
    Some(Goal {
        objective,
        status,
        tokens_used: value["tokensUsed"].as_u64().unwrap_or(0),
        token_budget: value["tokenBudget"].as_u64(),
        seconds_used: value["timeUsedSeconds"].as_u64().unwrap_or(0),
    })
}

/// `/goal` on its own: the reply.
pub fn describe(goal: Option<&Goal>) -> String {
    let Some(goal) = goal else {
        return "No goal is set.".into();
    };
    let status = match goal.status {
        GoalStatus::Active => "active",
        GoalStatus::Paused => "paused",
        GoalStatus::Blocked => "blocked",
        GoalStatus::UsageLimited => "stopped at a usage limit",
        GoalStatus::BudgetLimited => "out of token budget",
        GoalStatus::Complete => "complete",
    };
    format!("Goal {status}: {}", goal.objective)
}

/// The prompt a newly set goal's first turn starts with.
pub fn start_prompt(objective: &str) -> String {
    format!("Start working toward this goal: {objective}")
}

pub const RESUME_PROMPT: &str = "Continue working toward the goal.";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn goal_commands_parse() {
        assert_eq!(parse_goal("/goal"), Some(GoalCommand::Show));
        assert_eq!(parse_goal(" /goal  Edit "), Some(GoalCommand::Show));
        assert_eq!(parse_goal("/goal pause"), Some(GoalCommand::Pause));
        assert_eq!(
            parse_goal("/goal ship the login page"),
            Some(GoalCommand::Set("ship the login page".into()))
        );
        assert_eq!(parse_goal("/goals"), None);
        assert_eq!(parse_goal("set a /goal"), None);
    }

    #[test]
    fn feedback_takes_an_optional_reason() {
        assert_eq!(parse_feedback("/feedback"), Some(String::new()));
        assert_eq!(parse_feedback("/feedback it hung"), Some("it hung".into()));
        assert_eq!(parse_feedback("/feedbacks"), None);
    }

    #[test]
    fn a_wire_goal_reads() {
        let g = goal(&json!({"objective":"x","status":"usageLimited","tokensUsed":5,"timeUsedSeconds":9,"tokenBudget":null}))
            .unwrap();
        assert_eq!(g.status, GoalStatus::UsageLimited);
        assert_eq!((g.tokens_used, g.seconds_used, g.token_budget), (5, 9, None));
        assert_eq!(describe(None), "No goal is set.");
    }
}
