//! Browser tabs: real web pages in the tabs panel, shared by the user and
//! their agents (`mcp/browser.rs`'s `browser_*` tools).
//!
//! Each tab is a webview of its own inside the main window, laid over the
//! spot the page reserves for it ([`browser_place`]). It's native, so it
//! draws above everything the page itself draws: when a menu or a dialog
//! would overlap it, the page swaps it for a still picture
//! ([`browser_freeze`]) until the way is clear.
//!
//! The tabs live here, not in the page: opening one announces it
//! (`browser:opened`), and the page keeps a panel tab per browser tab. They
//! share one profile (`<data dir>/browser`), apart from the user's own
//! browser, and go when the page reloads, as terminals do.
//!
//! Pages get no way to call back into Outcode. Everything read from one is
//! asked for by evaluating script in it ([`Browsers::js`]), against the
//! helpers `browser/inject.js` leaves in every page.

mod native;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use outcode_engine::Engine;
use outcode_proto::Attachment;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, Url, Webview, WebviewUrl};
use tokio::sync::{oneshot, watch};

pub use native::{Clip, SCREENSHOTS, Shot};

const INJECT: &str = include_str!("browser/inject.js");

/// The window the tabs sit in, and the webview told about them.
const MAIN: &str = "main";

/// Where a tab waits while it isn't shown but must still paint (a screenshot
/// of a tab in the background): outside the window, so never seen.
const PARKED: PhysicalPosition<i32> = PhysicalPosition::new(-32000, -32000);
/// A tab's size until the page places it.
const DEFAULT_SIZE: PhysicalSize<u32> = PhysicalSize::new(1280, 800);

/// How long one script evaluation may take to come back.
const EVAL_WAIT: Duration = Duration::from_secs(8);

static NEXT_TAB: AtomicU64 = AtomicU64::new(1);
static NEXT_JOB: AtomicU64 = AtomicU64::new(1);

/// A page size to show a tab at, in CSS pixels, whatever room the panel has.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
}

/// A tab as the page shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabInfo {
    pub id: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub favicon: Option<String>,
    /// Set while the tab is shown at a fixed page size rather than the panel's.
    pub viewport: Option<Viewport>,
    /// The chat whose agent is acting on it right now.
    pub agent: Option<String>,
}

#[derive(Debug, Clone, Copy, Default)]
struct Load {
    /// Counts page loads started.
    generation: u64,
    loading: bool,
}

struct Tab {
    /// Missing only while it's being made.
    webview: Option<Webview>,
    /// The webview that shows it; its tabs go when it reloads.
    owner: String,
    info: TabInfo,
    /// Placed on screen by the page, rather than hidden.
    shown: bool,
    /// Where the page last put it: position, size, zoom.
    placed: Option<(PhysicalPosition<i32>, PhysicalSize<u32>, f64)>,
    /// Agent calls in flight, by chat.
    driving: Vec<String>,
    load: watch::Sender<Load>,
}

#[derive(Default)]
struct Inner {
    tabs: HashMap<String, Tab>,
    /// Oldest first.
    order: Vec<String>,
    /// The tab each chat's agent last used.
    last_used: HashMap<String, String>,
}

/// Every open browser tab.
pub struct Browsers {
    inner: Mutex<Inner>,
    /// The tabs' shared profile folder.
    profile: PathBuf,
}

/// Why a script didn't give a result.
#[derive(Debug)]
pub enum JsError {
    /// The page it ran on went away (a navigation) before it finished.
    Navigated,
    /// The script didn't parse.
    Syntax,
    Failed(String),
}

impl JsError {
    pub fn message(self) -> String {
        match self {
            Self::Navigated => "The page navigated away before it finished.".into(),
            Self::Syntax => "The code has a syntax error.".into(),
            Self::Failed(message) => message,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Go {
    Back,
    Forward,
    Reload,
    Stop,
}

fn label(id: &str) -> String {
    format!("browser-{id}")
}

/// What a tab may load. Anything else (`mailto:`, an app's own scheme) is
/// refused, as is Outcode's own page: there it would have Outcode's commands.
fn allowed(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "about" | "data" | "blob" | "file") && url.host_str() != Some("tauri.localhost")
}

/// Hosts served over plain http unless told otherwise: this machine and the local network.
fn is_local_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').split([']', ':', '/']).next().unwrap_or(host);
    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host == "0.0.0.0"
        || host == "::1"
        || host.starts_with("127.")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
}

/// What was typed as a URL: one with a scheme as is, a bare host given one
/// (`http` for local ones), a file's path as a `file:` URL. Anything else is
/// a web search when `search`, else refused.
pub fn parse_url(input: &str, search: bool) -> Result<Url, String> {
    let text = input.trim();
    if text.is_empty() {
        return Ok(Url::parse("about:blank").unwrap());
    }
    let refused = || format!("{text} isn't a web address Outcode's browser opens.");
    let lower = text.to_ascii_lowercase();
    if text.contains("://") || lower.starts_with("about:") || lower.starts_with("data:") {
        return Url::parse(text).ok().filter(allowed).ok_or_else(refused);
    }
    if Path::new(text).is_absolute() && Path::new(text).exists() {
        return Url::from_file_path(text).map_err(|()| refused());
    }
    let host_like = !text.contains(char::is_whitespace)
        && (text.contains('.') || text.starts_with('[') || is_local_host(text))
        && !text.starts_with('.');
    if host_like {
        let scheme = if is_local_host(text) { "http" } else { "https" };
        if let Ok(url) = Url::parse(&format!("{scheme}://{text}")) {
            return Ok(url);
        }
    }
    if search {
        return Url::parse_with_params("https://duckduckgo.com/", [("q", text)]).map_err(|_| refused());
    }
    Err(refused())
}

impl Browsers {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            inner: Mutex::default(),
            profile: data_dir.join("browser"),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn webview(&self, id: &str) -> Result<Webview, String> {
        self.lock()
            .tabs
            .get(id)
            .ok_or_else(|| format!("There's no browser tab {id}."))?
            .webview
            .clone()
            .ok_or_else(|| format!("Browser tab {id} is still opening."))
    }

    pub fn info(&self, id: &str) -> Option<TabInfo> {
        self.lock().tabs.get(id).map(|t| t.info.clone())
    }

    /// Every tab, oldest first.
    pub fn list(&self) -> Vec<TabInfo> {
        let inner = self.lock();
        inner.order.iter().filter_map(|id| inner.tabs.get(id)).map(|t| t.info.clone()).collect()
    }

    /// Whether the page has the tab on screen now.
    pub fn is_shown(&self, id: &str) -> bool {
        self.lock().tabs.get(id).is_some_and(|t| t.shown)
    }

    /// Changes a tab and tells the page.
    fn update(&self, app: &AppHandle, id: &str, change: impl FnOnce(&mut Tab)) {
        let info = {
            let mut inner = self.lock();
            let Some(tab) = inner.tabs.get_mut(id) else {
                return;
            };
            change(tab);
            tab.info.clone()
        };
        let _ = app.emit_to(MAIN, "browser:changed", info);
    }

    /// Opens a tab on `url` (blank without one) and tells the page, which
    /// gives it a panel tab. `by` is the chat whose agent asked, if one did.
    pub fn open(&self, app: &AppHandle, url: Option<Url>, by: Option<&str>) -> Result<TabInfo, String> {
        let window = app.get_window(MAIN).ok_or("Outcode's window is gone.")?;
        let url = url.unwrap_or_else(|| Url::parse("about:blank").unwrap());
        let id = format!("b{}", NEXT_TAB.fetch_add(1, Ordering::Relaxed));
        // A blank tab has nothing to load, and reports no load finishing.
        let loading = url.as_str() != "about:blank";
        let info = TabInfo {
            id: id.clone(),
            url: url.to_string(),
            title: String::new(),
            loading,
            can_go_back: !native::HISTORY,
            can_go_forward: !native::HISTORY,
            favicon: None,
            viewport: None,
            agent: None,
        };
        {
            // Listed before it exists, so its first page-load events find it.
            let mut inner = self.lock();
            inner.tabs.insert(
                id.clone(),
                Tab {
                    webview: None,
                    owner: MAIN.into(),
                    info: info.clone(),
                    shown: false,
                    placed: None,
                    driving: Vec::new(),
                    load: watch::channel(Load { generation: 1, loading }).0,
                },
            );
            inner.order.push(id.clone());
            if let Some(chat) = by {
                inner.last_used.insert(chat.to_owned(), id.clone());
            }
        }

        let builder = WebviewBuilder::new(label(&id), WebviewUrl::External(url))
            .data_directory(self.profile.clone())
            // A new webview would take the keyboard, away from the page (and
            // from the address field a blank tab starts in).
            .focused(false)
            .initialization_script(INJECT)
            .on_navigation(allowed)
            .on_page_load({
                let id = id.clone();
                move |webview, payload| page_load(&webview, &id, payload.event(), payload.url())
            })
            .on_document_title_changed({
                let id = id.clone();
                move |webview, title| {
                    let app = webview.app_handle();
                    app.state::<Browsers>().update(app, &id, |tab| tab.info.title = title);
                }
            })
            // A page opening a window gets a tab instead: the agent's, when
            // one is acting on the page that asked.
            .on_new_window({
                let (app, opener) = (app.clone(), id.clone());
                move |url, _| {
                    if allowed(&url) {
                        let (app, opener) = (app.clone(), opener.clone());
                        tauri::async_runtime::spawn(async move {
                            let browsers = app.state::<Browsers>();
                            let by = browsers.info(&opener).and_then(|tab| tab.agent);
                            let _ = browsers.open(&app, Some(url), by.as_deref());
                        });
                    }
                    NewWindowResponse::Deny
                }
            });
        // Made out of sight; the page places it once its panel tab shows.
        let webview = match window.add_child(builder, PARKED, DEFAULT_SIZE) {
            Ok(webview) => webview,
            Err(e) => {
                let mut inner = self.lock();
                inner.tabs.remove(&id);
                inner.order.retain(|t| t != &id);
                return Err(format!("The browser tab didn't open: {e}"));
            }
        };
        let _ = webview.hide();
        native::attach(&webview, {
            let (app, id) = (app.clone(), id.clone());
            move |url, back, forward| {
                app.state::<Browsers>().update(&app, &id, |tab| {
                    tab.info.url = url;
                    tab.info.can_go_back = back;
                    tab.info.can_go_forward = forward;
                });
            }
        });
        let info = {
            let mut inner = self.lock();
            let Some(tab) = inner.tabs.get_mut(&id) else {
                // Closed while it was being made.
                let _ = webview.close();
                return Err("The browser tab was closed.".into());
            };
            tab.webview = Some(webview);
            tab.info.clone()
        };
        let _ = app.emit_to(MAIN, "browser:opened", json!({ "tab": info, "chatId": by }));
        Ok(info)
    }

    pub fn close(&self, app: &AppHandle, id: &str) {
        let tab = {
            let mut inner = self.lock();
            inner.order.retain(|t| t != id);
            inner.last_used.retain(|_, tab| tab != id);
            inner.tabs.remove(id)
        };
        if let Some(tab) = tab {
            if let Some(webview) = tab.webview {
                let _ = webview.close();
            }
            let _ = app.emit_to(MAIN, "browser:closed", id);
        }
    }

    /// Closes the tabs webview `owner` showed: it's reloading.
    pub fn close_owned_by(&self, app: &AppHandle, owner: &str) {
        let ids: Vec<String> = {
            let inner = self.lock();
            inner.tabs.iter().filter(|(_, t)| t.owner == owner).map(|(id, _)| id.clone()).collect()
        };
        for id in ids {
            self.close(app, &id);
        }
    }

    /// The count of page loads the tab has started, for [`Browsers::settled`].
    pub fn generation(&self, id: &str) -> u64 {
        self.lock().tabs.get(id).map_or(0, |t| t.load.borrow().generation)
    }

    /// Waits for a page load started after `after` to finish, at most
    /// `limit`; gives up after `grace` if none has started by then (an
    /// in-page navigation, a click that went nowhere).
    pub async fn settled(&self, id: &str, after: u64, grace: Duration, limit: Duration) {
        let Some(mut load) = self.lock().tabs.get(id).map(|t| t.load.subscribe()) else {
            return;
        };
        let started = Instant::now();
        loop {
            let now = *load.borrow_and_update();
            let waited = started.elapsed();
            let begun = now.generation > after;
            if (begun && !now.loading) || (!begun && waited >= grace) || waited >= limit {
                return;
            }
            let wait = if begun { limit - waited } else { grace - waited };
            if matches!(tokio::time::timeout(wait, load.changed()).await, Ok(Err(_))) {
                return;
            }
        }
    }

    pub fn navigate(&self, app: &AppHandle, id: &str, url: Url) -> Result<(), String> {
        let webview = self.webview(id)?;
        self.update(app, id, |tab| {
            tab.info.url = url.to_string();
            tab.info.loading = true;
        });
        webview.navigate(url).map_err(|e| e.to_string())
    }

    pub fn go(&self, id: &str, go: Go) -> Result<(), String> {
        let webview = self.webview(id)?;
        match go {
            Go::Back => native::back(&webview),
            Go::Forward => native::forward(&webview),
            Go::Reload => webview.reload().map_err(|e| e.to_string())?,
            Go::Stop => native::stop(&webview),
        }
        Ok(())
    }

    /// Puts the tab on screen at `position` and `size` (physical pixels in
    /// the window), its page zoomed by `zoom`.
    pub fn place(&self, id: &str, position: PhysicalPosition<i32>, size: PhysicalSize<u32>, zoom: f64) -> Result<(), String> {
        let webview = self.webview(id)?;
        let (was_shown, old_zoom) = {
            let mut inner = self.lock();
            let tab = inner.tabs.get_mut(id).ok_or("That tab closed.")?;
            let old = (tab.shown, tab.placed.map(|p| p.2));
            tab.shown = true;
            tab.placed = Some((position, size, zoom));
            old
        };
        if old_zoom != Some(zoom) {
            let _ = webview.set_zoom(zoom);
        }
        let _ = webview.set_size(size);
        let _ = webview.set_position(position);
        if !was_shown {
            let _ = webview.show();
        }
        Ok(())
    }

    pub fn hide(&self, id: &str) {
        let webview = {
            let mut inner = self.lock();
            let Some(tab) = inner.tabs.get_mut(id) else {
                return;
            };
            tab.shown = false;
            tab.webview.clone()
        };
        if let Some(webview) = webview {
            let _ = webview.hide();
        }
    }

    /// Shows the tab at a fixed page size, or at the panel's (`None`). The
    /// page lays it out; a tab not on screen takes the size at once.
    pub fn set_viewport(&self, app: &AppHandle, id: &str, viewport: Option<Viewport>) -> Result<(), String> {
        let webview = self.webview(id)?;
        if !self.is_shown(id) {
            let scale = app.get_window(MAIN).and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
            let size = viewport.map_or(DEFAULT_SIZE, |v| {
                PhysicalSize::new((f64::from(v.width) * scale).round() as u32, (f64::from(v.height) * scale).round() as u32)
            });
            let _ = webview.set_zoom(1.0);
            let _ = webview.set_size(size);
            if let Some(tab) = self.lock().tabs.get_mut(id) {
                tab.placed = None;
            }
        }
        self.update(app, id, |tab| tab.info.viewport = viewport);
        Ok(())
    }

    pub fn devtools(&self, id: &str) -> Result<(), String> {
        native::devtools(&self.webview(id)?);
        Ok(())
    }

    /// How much the tab's page is scaled to fit where the page put it: under
    /// 1 for a fixed page size larger than the panel.
    pub fn zoom(&self, id: &str) -> f64 {
        self.lock().tabs.get(id).filter(|t| t.shown).and_then(|t| t.placed).map_or(1.0, |p| p.2)
    }

    /// The tab's picture. A tab that isn't on screen is parked outside the
    /// window meanwhile, so it paints.
    pub async fn screenshot(&self, id: &str, shot: Shot) -> Result<Vec<u8>, String> {
        let webview = self.webview(id)?;
        let parked = !self.is_shown(id);
        if parked {
            let _ = webview.set_position(PARKED);
            let _ = webview.show();
            // A frame or two to paint in.
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        let picture = native::screenshot(&webview, shot).await;
        if parked && !self.is_shown(id) {
            let _ = webview.hide();
        }
        picture
    }

    /// Evaluates `js` in the tab and gives what it evaluates to. Not for
    /// promises: see [`Browsers::js`].
    async fn eval(webview: &Webview, js: String) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel::<String>();
        let tx = Mutex::new(Some(tx));
        webview
            .eval_with_callback(js, move |out| {
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(out);
                }
            })
            .map_err(|e| e.to_string())?;
        let out = tokio::time::timeout(EVAL_WAIT, rx)
            .await
            .map_err(|_| "The page isn't responding.".to_owned())?
            .map_err(|_| "The tab closed.".to_owned())?;
        Ok(serde_json::from_str(&out).unwrap_or(Value::Null))
    }

    /// Runs `body` (an async function's body; `return` gives its result) in
    /// the tab's page and waits up to `limit` for it.
    pub async fn js(&self, id: &str, body: &str, limit: Duration) -> Result<Value, JsError> {
        let webview = self.webview(id).map_err(JsError::Failed)?;
        let job = format!("j{}", NEXT_JOB.fetch_add(1, Ordering::Relaxed));
        let start = format!(
            "(() => {{ try {{ if (!window.__outcode) return 'missing'; \
             return window.__outcode.start('{job}', async () => {{\n{body}\n}}); }} \
             catch (e) {{ return 'error:' + e; }} }})()"
        );
        let mut started = Self::eval(&webview, start.clone()).await.map_err(JsError::Failed)?;
        if started == "missing" {
            // A page loaded before the script could be added (the first, blank one).
            let _ = Self::eval(&webview, INJECT.to_owned()).await;
            started = Self::eval(&webview, start).await.map_err(JsError::Failed)?;
        }
        match started.as_str() {
            Some("started") => {}
            Some(other) => return Err(JsError::Failed(other.trim_start_matches("error:").trim().to_owned())),
            // A script that doesn't parse evaluates to nothing.
            None => return Err(JsError::Syntax),
        }

        let deadline = Instant::now() + limit;
        let mut pause = Duration::from_millis(15);
        loop {
            tokio::time::sleep(pause).await;
            pause = (pause * 2).min(Duration::from_millis(120));
            let poll = format!("window.__outcode ? window.__outcode.poll('{job}') : 'null'");
            let state = match Self::eval(&webview, poll).await {
                Ok(Value::String(json)) => serde_json::from_str::<Value>(&json).unwrap_or(Value::Null),
                Ok(_) => Value::Null,
                Err(e) => return Err(JsError::Failed(e)),
            };
            if state.is_null() {
                return Err(JsError::Navigated);
            }
            if state["done"] == true {
                return if state["ok"] == true {
                    Ok(state["value"].clone())
                } else {
                    Err(JsError::Failed(state["error"].as_str().unwrap_or("It failed.").to_owned()))
                };
            }
            if Instant::now() >= deadline {
                return Err(JsError::Failed(format!("It didn't finish within {} s.", limit.as_secs().max(1))));
            }
        }
    }

    /// Marks the tab as acted on by `chat`'s agent until the guard drops, and
    /// as the one that chat's later calls mean by default.
    pub fn drive(&self, app: &AppHandle, id: &str, chat: Option<&str>) -> Driving {
        let chat = chat.unwrap_or_default().to_owned();
        if !chat.is_empty() {
            self.lock().last_used.insert(chat.clone(), id.to_owned());
        }
        self.update(app, id, |tab| {
            tab.driving.push(chat.clone());
            tab.info.agent = tab.driving.last().cloned();
        });
        Driving { app: app.clone(), id: id.to_owned(), chat }
    }

    /// The tab a chat's agent means when it names none: the one it last
    /// used, else the one on screen, else the newest.
    pub fn default_tab(&self, chat: Option<&str>) -> Option<String> {
        let inner = self.lock();
        chat.and_then(|c| inner.last_used.get(c))
            .filter(|id| inner.tabs.contains_key(*id))
            .or_else(|| inner.order.iter().find(|id| inner.tabs.get(*id).is_some_and(|t| t.shown)))
            .or_else(|| inner.order.last())
            .cloned()
    }
}

/// An agent's call on a tab, in flight ([`Browsers::drive`]).
pub struct Driving {
    app: AppHandle,
    id: String,
    chat: String,
}

impl Drop for Driving {
    fn drop(&mut self) {
        let Some(browsers) = self.app.try_state::<Browsers>() else {
            return;
        };
        browsers.update(&self.app, &self.id, |tab| {
            if let Some(at) = tab.driving.iter().position(|c| c == &self.chat) {
                tab.driving.remove(at);
            }
            tab.info.agent = tab.driving.last().cloned();
        });
    }
}

fn page_load(webview: &Webview, id: &str, event: PageLoadEvent, url: &Url) {
    let app = webview.app_handle();
    let browsers = app.state::<Browsers>();
    let finished = matches!(event, PageLoadEvent::Finished) || url.as_str() == "about:blank";
    browsers.update(app, id, |tab| {
        // The blank page a tab starts on may report in after the tab has
        // been sent elsewhere: that isn't where it is.
        if url.as_str() != "about:blank" || tab.info.url.is_empty() {
            tab.info.url = url.to_string();
        }
        tab.info.loading = !finished;
        if finished {
            tab.load.send_modify(|load| load.loading = false);
        } else {
            tab.info.favicon = None;
            tab.load.send_modify(|load| {
                load.generation += 1;
                load.loading = true;
            });
        }
    });
    if finished {
        // The title and icon the page settled on.
        let (app, id, webview) = (app.clone(), id.to_owned(), webview.clone());
        tauri::async_runtime::spawn(async move {
            let js = "(() => { try { return JSON.stringify(window.__outcode.status()); } catch (e) { return 'null'; } })()";
            let Ok(Value::String(json)) = Browsers::eval(&webview, js.into()).await else {
                return;
            };
            let Ok(status) = serde_json::from_str::<Value>(&json) else {
                return;
            };
            app.state::<Browsers>().update(&app, &id, |tab| {
                if let Some(title) = status["title"].as_str() {
                    tab.info.title = title.to_owned();
                }
                tab.info.favicon = status["favicon"].as_str().map(str::to_owned);
            });
        });
    }
}

fn save(app: &AppHandle, name: &str, bytes: &[u8]) -> Result<Attachment, String> {
    app.state::<Engine>().store().save_attachment(name, bytes).map_err(|e| e.to_string())
}

// ── The page's commands ─────────────────────────────────────────────────

/// Opens a tab on what was typed (a URL, a host, a search), or a blank one.
#[tauri::command]
pub async fn browser_open(app: AppHandle, browsers: State<'_, Browsers>, url: Option<String>) -> Result<TabInfo, String> {
    let url = url.as_deref().map(|u| parse_url(u, true)).transpose()?;
    let tab = browsers.open(&app, url, None)?;
    // The keyboard stays with the page, whatever the new webview did.
    if let Some(page) = app.get_webview(MAIN) {
        let _ = page.set_focus();
    }
    Ok(tab)
}

/// The open tabs, for a page that started after some were opened.
#[tauri::command]
pub async fn browser_list(browsers: State<'_, Browsers>) -> Result<Vec<TabInfo>, String> {
    Ok(browsers.list())
}

#[tauri::command]
pub async fn browser_close(app: AppHandle, browsers: State<'_, Browsers>, id: String) -> Result<(), String> {
    browsers.close(&app, &id);
    Ok(())
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, browsers: State<'_, Browsers>, id: String, url: String) -> Result<(), String> {
    browsers.navigate(&app, &id, parse_url(&url, true)?)
}

#[tauri::command]
pub async fn browser_go(browsers: State<'_, Browsers>, id: String, go: Go) -> Result<(), String> {
    browsers.go(&id, go)
}

/// Puts the tab over its spot in the page: physical pixels from the window's
/// corner. `page_width` is how wide the page should find itself, in CSS
/// pixels, when that isn't the spot's own width (a fixed page size, scaled
/// to fit).
#[tauri::command]
pub async fn browser_place(
    app: AppHandle,
    browsers: State<'_, Browsers>,
    id: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    page_width: Option<f64>,
) -> Result<(), String> {
    let zoom = match page_width.filter(|w| *w >= 1.0) {
        Some(page_width) => {
            let scale = app.get_window(MAIN).and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
            (f64::from(width) / (scale * page_width)).clamp(0.1, 5.0)
        }
        None => 1.0,
    };
    browsers.place(&id, PhysicalPosition::new(x, y), PhysicalSize::new(width.max(1), height.max(1)), zoom)
}

#[tauri::command]
pub async fn browser_hide(browsers: State<'_, Browsers>, id: String) -> Result<(), String> {
    browsers.hide(&id);
    Ok(())
}

/// Hides the tab and gives a picture of it to show in its place (JPEG
/// bytes; none where screenshots aren't supported).
#[tauri::command]
pub async fn browser_freeze(browsers: State<'_, Browsers>, id: String) -> Result<tauri::ipc::Response, String> {
    let picture = if browsers.is_shown(&id) {
        let shot = Shot { jpeg: true, ..Shot::default() };
        tokio::time::timeout(Duration::from_millis(1500), browsers.screenshot(&id, shot))
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    browsers.hide(&id);
    Ok(tauri::ipc::Response::new(picture))
}

#[tauri::command]
pub async fn browser_set_viewport(
    app: AppHandle,
    browsers: State<'_, Browsers>,
    id: String,
    viewport: Option<Viewport>,
) -> Result<(), String> {
    browsers.set_viewport(&app, &id, viewport)
}

#[tauri::command]
pub async fn browser_devtools(browsers: State<'_, Browsers>, id: String) -> Result<(), String> {
    browsers.devtools(&id)
}

/// A picture of the tab, kept as an attachment for the composer.
#[tauri::command]
pub async fn browser_capture(app: AppHandle, browsers: State<'_, Browsers>, id: String) -> Result<Attachment, String> {
    let picture = browsers.screenshot(&id, Shot::default()).await?;
    save(&app, "screenshot.png", &picture)
}

/// An element the user picked in the page.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Picked {
    selector: String,
    tag: String,
    text: String,
    html: String,
    url: String,
    /// Its picture, where screenshots are supported.
    attachment: Option<Attachment>,
}

/// Lets the user click an element in the tab; `None` when they back out.
#[tauri::command]
pub async fn browser_pick(app: AppHandle, browsers: State<'_, Browsers>, id: String) -> Result<Option<Picked>, String> {
    let picked = match browsers.js(&id, "return await window.__outcode.pick();", Duration::from_secs(300)).await {
        Ok(picked) => picked,
        Err(JsError::Navigated) => return Ok(None),
        Err(e) => return Err(e.message()),
    };
    if picked.is_null() {
        return Ok(None);
    }
    let text = |key: &str| picked[key].as_str().unwrap_or_default().to_owned();
    let rect = &picked["rect"];
    let clip = Clip {
        x: rect["x"].as_f64().unwrap_or(0.0),
        y: rect["y"].as_f64().unwrap_or(0.0),
        width: rect["width"].as_f64().unwrap_or(0.0),
        height: rect["height"].as_f64().unwrap_or(0.0),
    };
    let attachment = match browsers.screenshot(&id, Shot { clip: Some(clip), ..Shot::default() }).await {
        Ok(picture) => save(&app, "element.png", &picture).ok(),
        Err(_) => None,
    };
    Ok(Some(Picked {
        selector: text("selector"),
        tag: text("tag"),
        text: text("text"),
        html: text("html"),
        url: browsers.info(&id).map(|t| t.url).unwrap_or_default(),
        attachment,
    }))
}

#[tauri::command]
pub async fn browser_pick_cancel(browsers: State<'_, Browsers>, id: String) -> Result<(), String> {
    if let Ok(webview) = browsers.webview(&id) {
        let _ = webview.eval("window.__outcode && window.__outcode.cancelPick()");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_addresses_become_urls() {
        let url = |text: &str| parse_url(text, true).unwrap().to_string();
        assert_eq!(url("localhost:3000"), "http://localhost:3000/");
        assert_eq!(url("127.0.0.1:8080/app"), "http://127.0.0.1:8080/app");
        assert_eq!(url("example.com/a?b=1"), "https://example.com/a?b=1");
        assert_eq!(url("http://example.com"), "http://example.com/");
        assert_eq!(url(""), "about:blank");
        assert_eq!(url("rust tauri webview"), "https://duckduckgo.com/?q=rust+tauri+webview");
        assert!(parse_url("rust tauri webview", false).is_err());
        assert!(parse_url("javascript://alert(1)", true).is_err());
        assert!(parse_url("mailto://someone", true).is_err());
        assert!(parse_url("http://tauri.localhost/", true).is_err());
    }
}
