//! Secrets an agent asks the user for, as in t3code: Hive's `request_secret`
//! tool puts up a card ([`Engine::open_secret_request`]) and waits. What the
//! user types comes straight here from the card (`answer_secret_request`)
//! and goes into a private file, never into the chat, its journal or the
//! engine; the agent gets the file's path to read inside its commands.
//!
//! Files live in `<data dir>/secrets/<chat id>/`, owner-only on unix (the
//! data dir is already private to the user on Windows), and go after
//! [`TTL`] or with their chat.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime};

use hive_engine::Engine;
use hive_mcp::Ctx;
use hive_proto::SecretRequest;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tokio::sync::oneshot;

/// How long a saved secret's file is kept.
pub const TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// How long the tool waits for the user unless the agent says otherwise.
const DEFAULT_WAIT: Duration = Duration::from_secs(10 * 60);
const MIN_WAIT: u64 = 10;
/// The longest the tool waits; the CLIs give it a little more
/// ([`hive_proto::McpServer::TOOL_TIMEOUT_SECS`]).
const MAX_WAIT: u64 = 60 * 60;

pub const TOOL: &str = "request_secret";

pub const DESCRIPTION: &str = "Ask the user for a secret (an API key, token or password) in a private card in Hive, and wait for them. The value never appears in the chat. Saved, you get the path of a private file holding it: read it inside your commands (e.g. TOKEN=\"$(cat <file>)\" some-cli login) and never print, echo or copy it; it's deleted after 24 hours. When you need a secret from the user, call this instead of asking for it in chat.";

pub fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "label": {
                "type": "string",
                "description": "The card's title, e.g. \"Tailscale auth key\"."
            },
            "reason": {
                "type": "string",
                "description": "What it's for and where to get it: the page to open, the options to pick."
            },
            "placeholder": {
                "type": "string",
                "description": "The empty field's hint, e.g. \"tskey-auth-…\"."
            },
            "timeoutSec": {
                "type": "integer",
                "minimum": MIN_WAIT,
                "maximum": MAX_WAIT,
                "description": "How long to wait for the user. Default 600 (10 minutes)."
            }
        },
        "required": ["label", "reason"],
        "additionalProperties": false
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Args {
    label: String,
    reason: String,
    #[serde(default)]
    placeholder: Option<String>,
    #[serde(default)]
    timeout_sec: Option<u64>,
}

/// What the card's answer hands the waiting tool call.
enum Reply {
    Saved(PathBuf),
    Declined,
}

struct Pending {
    chat_id: String,
    reply: oneshot::Sender<Reply>,
}

/// The tool calls waiting on a card, by request id.
pub struct Secrets {
    dir: PathBuf,
    pending: Mutex<HashMap<String, Pending>>,
}

impl Secrets {
    pub fn new(data_dir: &Path) -> Arc<Self> {
        Arc::new(Self {
            dir: data_dir.join("secrets"),
            pending: Mutex::default(),
        })
    }

    fn pending(&self) -> MutexGuard<'_, HashMap<String, Pending>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Clears out expired files now and every hour after.
    pub fn sweep_every_hour(self: &Arc<Self>) {
        let secrets = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            loop {
                sweep(&secrets.dir, TTL);
                tokio::time::sleep(Duration::from_secs(60 * 60)).await;
            }
        });
    }

    /// Deletes a chat's saved secrets, with the chat.
    pub fn forget_chat(&self, chat_id: &str) {
        let Some(dir) = self.chat_dir(chat_id) else {
            return;
        };
        if let Err(e) = fs::remove_dir_all(&dir) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!("deleting {}: {e}", dir.display());
            }
        }
    }

    fn chat_dir(&self, chat_id: &str) -> Option<PathBuf> {
        let safe = !chat_id.is_empty()
            && chat_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        safe.then(|| self.dir.join(chat_id))
    }

    /// The tool: puts up the card and waits for the user, the timeout, or
    /// the turn ending (a stop, the agent exiting), whichever comes first.
    async fn request(&self, engine: &Engine, ctx: Ctx, args: Value) -> Result<Value, String> {
        let chat_id = ctx.chat_id.ok_or("This session isn't a Hive chat.")?;
        let args: Args =
            serde_json::from_value(args).map_err(|e| format!("Bad arguments: {e}"))?;
        let label = args.label.trim();
        let reason = args.reason.trim();
        if label.is_empty() || reason.is_empty() {
            return Err("`label` and `reason` can't be empty.".into());
        }
        let wait = args
            .timeout_sec
            .map_or(DEFAULT_WAIT, |s| Duration::from_secs(s.clamp(MIN_WAIT, MAX_WAIT)));

        let id = uuid::Uuid::new_v4().simple().to_string();
        let (reply, answered) = oneshot::channel();
        self.pending().insert(
            id.clone(),
            Pending {
                chat_id: chat_id.clone(),
                reply,
            },
        );
        let request = SecretRequest {
            id: id.clone(),
            label: label.to_owned(),
            reason: reason.to_owned(),
            placeholder: args
                .placeholder
                .map(|p| p.trim().to_owned())
                .filter(|p| !p.is_empty()),
            requested_at: hive_store::now_ms(),
        };
        let ended = match engine.open_secret_request(&chat_id, request) {
            Ok(ended) => ended,
            Err(e) => {
                self.pending().remove(&id);
                return Err(e.to_string());
            }
        };

        let result = tokio::select! {
            reply = answered => match reply {
                Ok(Reply::Saved(file)) => json!({
                    "status": "saved",
                    "file": file,
                    "note": "Read the file inside your commands; never print it. Deleted after 24 hours.",
                }),
                Ok(Reply::Declined) => json!({
                    "status": "declined",
                    "note": "The user chose not to give it.",
                }),
                Err(_) => json!({ "status": "cancelled" }),
            },
            _ = ended => json!({ "status": "cancelled" }),
            _ = tokio::time::sleep(wait) => json!({
                "status": "timed_out",
                "note": "No answer in time. Ask again if you still need it.",
            }),
        };
        self.pending().remove(&id);
        engine.close_secret_request(&chat_id, &id);
        Ok(result)
    }

    /// The card's answer: `value` saved to a private file, or None to decline.
    fn answer(&self, chat_id: &str, request_id: &str, value: Option<String>) -> Result<(), String> {
        let pending = {
            let mut all = self.pending();
            match all.get(request_id) {
                Some(p) if p.chat_id == chat_id => all.remove(request_id),
                _ => None,
            }
        }
        .ok_or("The agent is no longer waiting for this secret.")?;

        let Some(value) = value else {
            let _ = pending.reply.send(Reply::Declined);
            return Ok(());
        };
        let value = value.trim();
        if value.is_empty() {
            self.pending().insert(request_id.to_owned(), pending);
            return Err("The secret is empty.".into());
        }
        let file = match self.write(chat_id, request_id, value) {
            Ok(file) => file,
            Err(e) => {
                // Still waiting: the card can try again.
                self.pending().insert(request_id.to_owned(), pending);
                log::warn!("saving a secret: {e}");
                return Err(format!("Couldn't save the secret: {e}"));
            }
        };
        if pending.reply.send(Reply::Saved(file.clone())).is_err() {
            let _ = fs::remove_file(&file);
            return Err("The agent is no longer waiting for this secret.".into());
        }
        Ok(())
    }

    fn write(&self, chat_id: &str, request_id: &str, value: &str) -> std::io::Result<PathBuf> {
        let dir = self
            .chat_dir(chat_id)
            .ok_or_else(|| std::io::Error::other("bad chat id"))?;
        private_dir(&self.dir)?;
        private_dir(&dir)?;
        let file = dir.join(request_id);
        let partial = dir.join(format!("{request_id}.partial"));
        let _ = fs::remove_file(&partial);
        let written = (|| {
            let mut out = private_file(&partial)?;
            out.write_all(value.as_bytes())?;
            out.sync_all()?;
            drop(out);
            fs::rename(&partial, &file)
        })();
        if written.is_err() {
            let _ = fs::remove_file(&partial);
        }
        written.map(|()| file)
    }
}

/// `request_secret`'s handler, with the app's engine and [`Secrets`].
pub async fn request(app: AppHandle, ctx: Ctx, args: Value) -> Result<Value, String> {
    let engine = app
        .try_state::<Engine>()
        .ok_or("Hive is still starting.")?
        .inner()
        .clone();
    let secrets = Arc::clone(app.state::<Arc<Secrets>>().inner());
    secrets.request(&engine, ctx, args).await
}

/// The card's answer: `value` is saved for the agent; None declines.
#[tauri::command]
pub async fn answer_secret_request(
    secrets: State<'_, Arc<Secrets>>,
    chat_id: String,
    request_id: String,
    value: Option<String>,
) -> Result<(), String> {
    secrets.answer(&chat_id, &request_id, value)
}

#[cfg(unix)]
fn private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn private_dir(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)
}

/// A new file only its owner can read; never an existing path.
fn private_file(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)
}

/// Deletes saved secrets older than `ttl`, and chat folders left empty.
fn sweep(dir: &Path, ttl: Duration) {
    let Ok(chats) = fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for chat in chats.flatten() {
        let path = chat.path();
        if !path.is_dir() {
            continue;
        }
        for file in fs::read_dir(&path).into_iter().flatten().flatten() {
            let old = file
                .metadata()
                .and_then(|m| m.modified())
                .map(|t| now.duration_since(t).unwrap_or_default() > ttl)
                .unwrap_or(true);
            if old {
                if let Err(e) = fs::remove_file(file.path()) {
                    log::warn!("deleting an expired secret: {e}");
                }
            }
        }
        // Only succeeds once it's empty.
        let _ = fs::remove_dir(&path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn waiting(secrets: &Secrets, chat_id: &str, id: &str) -> oneshot::Receiver<Reply> {
        let (reply, rx) = oneshot::channel();
        secrets.pending().insert(
            id.into(),
            Pending {
                chat_id: chat_id.into(),
                reply,
            },
        );
        rx
    }

    #[test]
    fn a_saved_secret_lands_in_a_private_file_for_the_waiting_call() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Secrets::new(dir.path());
        let mut rx = waiting(&secrets, "chat-1", "r1");

        // Only the chat that asked, and something to save.
        assert!(secrets.answer("chat-2", "r1", Some("x".into())).is_err());
        assert!(secrets.answer("chat-1", "r1", Some("  ".into())).is_err());
        secrets.answer("chat-1", "r1", Some(" tskey-123\n".into())).unwrap();

        let Ok(Reply::Saved(file)) = rx.try_recv() else {
            panic!("not saved");
        };
        assert_eq!(file, dir.path().join("secrets").join("chat-1").join("r1"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "tskey-123");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&file).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // Answered once.
        assert!(secrets.answer("chat-1", "r1", Some("again".into())).is_err());

        secrets.forget_chat("chat-1");
        assert!(!file.exists());
    }

    #[test]
    fn a_declined_or_abandoned_request_keeps_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Secrets::new(dir.path());
        let mut rx = waiting(&secrets, "c", "r1");
        secrets.answer("c", "r1", None).unwrap();
        assert!(matches!(rx.try_recv(), Ok(Reply::Declined)));

        // The call gave up between the card's answer and the reply.
        drop(waiting(&secrets, "c", "r2"));
        assert!(secrets.answer("c", "r2", Some("tok".into())).is_err());
        assert!(!dir.path().join("secrets").join("c").join("r2").exists());
    }

    #[test]
    fn sweep_takes_expired_files_and_empty_folders() {
        let dir = tempfile::tempdir().unwrap();
        let chat = dir.path().join("c");
        fs::create_dir_all(&chat).unwrap();
        fs::write(chat.join("r1"), "x").unwrap();
        sweep(dir.path(), TTL);
        assert!(chat.join("r1").exists());
        sweep(dir.path(), Duration::ZERO);
        assert!(!chat.exists());
    }
}
