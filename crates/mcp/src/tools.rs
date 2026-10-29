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
pub struct ToolDef {
    pub name: String,
    pub description: String,
    /// JSON Schema of the arguments; an object schema.
    pub input_schema: Value,
}

/// Who's calling.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ctx {
    /// The chat whose agent called, when the engine launched the bridge.
    pub chat_id: Option<String>,
}

type Handler = Arc<dyn Fn(Ctx, Value) -> BoxFuture<'static, Result<Value, String>> + Send + Sync>;

/// The tools a [`Host`] offers. A handler's `Ok` is the tool's result (a
/// string goes to the agent as is, anything else as pretty JSON); its `Err`
/// is shown to the agent as a failed call.
///
/// [`Host`]: crate::Host
#[derive(Clone, Default)]
pub struct Tools {
    tools: Vec<(ToolDef, Handler)>,
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

    pub fn defs(&self) -> Vec<ToolDef> {
        self.tools.iter().map(|(d, _)| d.clone()).collect()
    }

    pub async fn call(&self, name: &str, ctx: Ctx, arguments: Value) -> Result<Value, String> {
        let handler = self
            .tools
            .iter()
            .find(|(d, _)| d.name == name)
            .map(|(_, h)| Arc::clone(h))
            .ok_or_else(|| format!("unknown tool: {name}"))?;
        handler(ctx, arguments).await
    }
}
