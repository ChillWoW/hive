//! The tool catalog and the code behind each tool, run by the [`Host`].
//!
//! [`Host`]: crate::Host

use std::future::Future;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

use crate::BoxFuture;

/// A tool as `tools/list` shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolDef {
    name: String,
    description: String,
    /// JSON Schema of the arguments; an object schema.
    input_schema: Value,
}

/// Who's calling.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ctx {
    /// The chat whose agent called, when the engine launched the bridge.
    pub chat_id: Option<String>,
}

type Handler = Arc<dyn Fn(Ctx, Value) -> BoxFuture<'static, Result<Value, String>> + Send + Sync>;
type Shown = Arc<dyn Fn(&Ctx, &str) -> bool + Send + Sync>;

/// The tools a [`Host`] offers. A handler's `Ok` is the tool's result (a
/// string goes to the agent as is, anything else as pretty JSON); its `Err`
/// is shown to the agent as a failed call.
///
/// [`Host`]: crate::Host
#[derive(Clone, Default)]
pub struct Tools {
    tools: Vec<(ToolDef, Handler)>,
    /// Which tools a caller gets; all of them when unset.
    shown: Option<Shown>,
}

impl Tools {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a tool; a later one with the same name replaces it.
    pub fn tool<F, Fut>(
        mut self,
        name: impl Into<String>,
        description: impl Into<String>,
        input_schema: Value,
        handler: F,
    ) -> Self
    where
        F: Fn(Ctx, Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, String>> + Send + 'static,
    {
        let def = ToolDef {
            name: name.into(),
            description: description.into(),
            input_schema,
        };
        self.tools.retain(|(d, _)| d.name != def.name);
        let handler: Handler = Arc::new(move |ctx, args| Box::pin(handler(ctx, args)));
        self.tools.push((def, handler));
        self
    }

    /// Offers a caller only the tools `shown(caller, name)` passes: the rest
    /// are left out of its list and refused as unknown.
    pub fn shown_when(mut self, shown: impl Fn(&Ctx, &str) -> bool + Send + Sync + 'static) -> Self {
        self.shown = Some(Arc::new(shown));
        self
    }

    fn offered(&self, ctx: &Ctx, name: &str) -> bool {
        self.shown.as_ref().is_none_or(|shown| shown(ctx, name))
    }

    /// `tools/list`'s `tools`, as `ctx` gets them.
    pub(crate) fn catalog(&self, ctx: &Ctx) -> Value {
        let defs: Vec<&ToolDef> = self
            .tools
            .iter()
            .map(|(d, _)| d)
            .filter(|d| self.offered(ctx, &d.name))
            .collect();
        serde_json::to_value(defs).unwrap_or_default()
    }

    pub(crate) async fn call(&self, name: &str, ctx: Ctx, arguments: Value) -> Result<Value, String> {
        let handler = self
            .tools
            .iter()
            .find(|(d, _)| d.name == name && self.offered(&ctx, name))
            .map(|(_, h)| Arc::clone(h))
            .ok_or_else(|| format!("unknown tool: {name}"))?;
        handler(ctx, arguments).await
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[tokio::test]
    async fn hidden_tools_are_left_out_and_refused() {
        let tools = Tools::new()
            .tool("open", "", json!({}), |_, _| async { Ok(json!(1)) })
            .tool("parents_only", "", json!({}), |_, _| async { Ok(json!(2)) })
            .shown_when(|ctx, name| name != "parents_only" || ctx.chat_id.as_deref() == Some("parent"));
        let names = |ctx: &Ctx| -> Vec<String> {
            tools.catalog(ctx).as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_owned()).collect()
        };
        let parent = Ctx { chat_id: Some("parent".into()) };
        let child = Ctx { chat_id: Some("child".into()) };
        assert_eq!(names(&parent), ["open", "parents_only"]);
        assert_eq!(names(&child), ["open"]);
        assert!(tools.call("parents_only", child, json!({})).await.is_err());
        assert_eq!(tools.call("parents_only", parent, json!({})).await, Ok(json!(2)));
    }
}
