//! What the harnesses share about models: reasoning levels by name, the
//! fast-mode option and a model list fetched in the background.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hive_proto::{ModelOption, ModelOptionChoice, ReasoningLevel, RunRequest};

/// The model option for fast mode, on models that offer it.
pub(crate) const FAST_MODE: &str = "fastMode";

/// How long a fetched model list is used before it's fetched again.
const MODELS_TTL: Duration = Duration::from_secs(10 * 60);

pub(crate) fn fast_mode_option() -> ModelOption {
    ModelOption {
        id: FAST_MODE.into(),
        label: "Fast mode".into(),
        choices: vec![choice("off", "Off"), choice("on", "On")],
        default_choice: "off".into(),
    }
}

pub(crate) fn choice(id: &str, label: &str) -> ModelOptionChoice {
    ModelOptionChoice {
        id: id.into(),
        label: label.into(),
    }
}

/// Whether the run's model options turn fast mode on.
pub(crate) fn fast_mode(request: &RunRequest) -> bool {
    request.model_options.get(FAST_MODE).map(String::as_str) == Some("on")
}

/// A level by its usual name (`minimal` … `max`).
pub(crate) fn level(name: &str) -> Option<ReasoningLevel> {
    Some(match name {
        "minimal" => ReasoningLevel::Minimal,
        "low" => ReasoningLevel::Low,
        "medium" => ReasoningLevel::Medium,
        "high" => ReasoningLevel::High,
        "xhigh" => ReasoningLevel::XHigh,
        "max" => ReasoningLevel::Max,
        _ => return None,
    })
}

/// A level's usual name, as [`level`] reads it.
pub(crate) fn level_name(level: ReasoningLevel) -> &'static str {
    match level {
        ReasoningLevel::Minimal => "minimal",
        ReasoningLevel::Low => "low",
        ReasoningLevel::Medium => "medium",
        ReasoningLevel::High => "high",
        ReasoningLevel::XHigh => "xhigh",
        ReasoningLevel::Max => "max",
    }
}

/// A model list fetched in the background and kept for [`MODELS_TTL`].
pub(crate) struct ModelCache<M> {
    state: Arc<Mutex<CacheState<M>>>,
}

struct CacheState<M> {
    models: Option<M>,
    fetched: Option<Instant>,
    refreshing: bool,
}

impl<M> Default for ModelCache<M> {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(CacheState {
                models: None,
                fetched: None,
                refreshing: false,
            })),
        }
    }
}

impl<M: Clone + Send + 'static> ModelCache<M> {
    /// The last list fetched, if any.
    pub(crate) fn get(&self) -> Option<M> {
        self.state.lock().unwrap().models.clone()
    }

    /// Runs `fetch` in the background (for at most `timeout`) when the list
    /// is missing or old; an answer `usable` refuses keeps the old one.
    pub(crate) fn refresh<F>(&self, timeout: Duration, fetch: F, usable: fn(&M) -> bool)
    where
        F: Future<Output = Result<M, String>> + Send + 'static,
    {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        {
            let mut state = self.state.lock().unwrap();
            let fresh = state.fetched.is_some_and(|at| at.elapsed() < MODELS_TTL);
            if fresh || state.refreshing {
                return;
            }
            state.refreshing = true;
        }
        let state = Arc::clone(&self.state);
        runtime.spawn(async move {
            let listed = tokio::time::timeout(timeout, fetch).await;
            let mut state = state.lock().unwrap();
            state.refreshing = false;
            // A failure waits out the TTL too, rather than starting a server
            // per catalog call.
            state.fetched = Some(Instant::now());
            if let Ok(Ok(models)) = listed {
                if usable(&models) {
                    state.models = Some(models);
                }
            }
        });
    }
}
