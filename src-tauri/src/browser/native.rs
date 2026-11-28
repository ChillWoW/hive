//! What a browser tab needs from the platform's own webview, beyond what
//! Tauri offers: screenshots, the page's history state, DevTools.
//!
//! Windows (WebView2) has all of it. Elsewhere screenshots and history state
//! are still to do (macOS: `WKWebView.takeSnapshot`, `canGoBack` /
//! `canGoForward`): tabs work, but freeze blank under menus, and
//! `browser_screenshot` and picking an element's picture are refused.

use tauri::Webview;

/// A screenshot to take.
#[derive(Debug, Clone, Copy, Default)]
pub struct Shot {
    /// The whole page, not just what's scrolled into view.
    pub full_page: bool,
    /// JPEG (smaller, quicker) rather than PNG.
    pub jpeg: bool,
    /// Only this part of the page, in CSS pixels from the document's corner.
    pub clip: Option<Clip>,
    /// Pixels per CSS pixel, when not the tab's own (a page scaled down to
    /// fit its panel is still pictured at full size).
    pub scale: Option<f64>,
}

#[derive(Debug, Clone, Copy)]
pub struct Clip {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Whether [`attach`] reports the history state; without it Back and Forward
/// are always offered.
pub const HISTORY: bool = cfg!(windows);

/// A key pressed in a tab's page, with the modifiers held: its name as
/// shortcuts are written in the settings (`W`, `1`, `,`, `F5`, `Tab`, `Up`).
#[derive(Debug, Clone)]
pub struct KeyPress {
    pub key: &'static str,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    /// Held down: this is the key repeating.
    pub repeat: bool,
}

/// Whether [`screenshot`] works here.
pub const SCREENSHOTS: bool = cfg!(windows);

pub use imp::*;

#[cfg(windows)]
mod imp {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use base64::Engine as _;
    use serde_json::{Value, json};
    use tokio::sync::oneshot;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
        COREWEBVIEW2_PHYSICAL_KEY_STATUS, ICoreWebView2, ICoreWebView2AcceleratorKeyPressedEventArgs,
    };
    use webview2_com::{
        AcceleratorKeyPressedEventHandler, CallDevToolsProtocolMethodCompletedHandler, HistoryChangedEventHandler, take_pwstr,
    };
    use windows_core::{BOOL, HSTRING, PWSTR};

    use super::*;

    /// The tallest full-page screenshot, in CSS pixels.
    const MAX_PAGE_HEIGHT: f64 = 12_000.0;

    /// Turns DevTools on for the tab and calls `on_history(url, can_go_back,
    /// can_go_forward)` whenever its history changes (in-page navigations too).
    pub fn attach(webview: &Webview, on_history: impl Fn(String, bool, bool) + Send + 'static) {
        let _ = webview.with_webview(move |platform| unsafe {
            let Ok(core) = platform.controller().CoreWebView2() else {
                return;
            };
            if let Ok(settings) = core.Settings() {
                let _ = settings.SetAreDevToolsEnabled(true);
            }
            let handler = HistoryChangedEventHandler::create(Box::new(move |core: Option<ICoreWebView2>, _| {
                if let Some(core) = core {
                    let (mut back, mut forward) = (BOOL::default(), BOOL::default());
                    core.CanGoBack(&mut back)?;
                    core.CanGoForward(&mut forward)?;
                    let mut source = PWSTR::null();
                    core.Source(&mut source)?;
                    on_history(take_pwstr(source), back.as_bool(), forward.as_bool());
                }
                Ok(())
            }));
            let mut token = 0;
            let _ = core.add_HistoryChanged(&handler, &mut token);
        });
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetKeyState(virtual_key: i32) -> i16;
    }

    /// A virtual-key code's name, for the keys a shortcut can use.
    fn key_name(virtual_key: u32) -> Option<&'static str> {
        const LETTERS: [&str; 26] = [
            "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X",
            "Y", "Z",
        ];
        const DIGITS: [&str; 10] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
        const FUNCTION: [&str; 12] = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"];
        Some(match virtual_key {
            0x30..=0x39 => DIGITS[(virtual_key - 0x30) as usize],
            0x41..=0x5A => LETTERS[(virtual_key - 0x41) as usize],
            0x70..=0x7B => FUNCTION[(virtual_key - 0x70) as usize],
            0x08 => "Backspace",
            0x09 => "Tab",
            0x0D => "Enter",
            0x1B => "Escape",
            0x20 => "Space",
            0x21 => "PageUp",
            0x22 => "PageDown",
            0x23 => "End",
            0x24 => "Home",
            0x25 => "Left",
            0x26 => "Up",
            0x27 => "Right",
            0x28 => "Down",
            0x2E => "Delete",
            0xBA => ";",
            0xBB => "=",
            0xBC => ",",
            0xBD => "-",
            0xBE => ".",
            0xBF => "/",
            0xC0 => "`",
            0xDB => "[",
            0xDC => "\\",
            0xDD => "]",
            0xDE => "'",
            _ => return None,
        })
    }

    /// Calls `on_key` for each shortcut-like key pressed while the tab's page
    /// has the keyboard (with Ctrl or Alt, or a function key), before the
    /// page sees it; true keeps it from the page.
    pub fn watch_keys(webview: &Webview, on_key: impl Fn(KeyPress) -> bool + Send + 'static) {
        let _ = webview.with_webview(move |platform| unsafe {
            let handler = AcceleratorKeyPressedEventHandler::create(Box::new(
                move |_, args: Option<ICoreWebView2AcceleratorKeyPressedEventArgs>| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
                    args.KeyEventKind(&mut kind)?;
                    if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN {
                        return Ok(());
                    }
                    let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
                    args.PhysicalKeyStatus(&mut status)?;
                    let mut virtual_key = 0;
                    args.VirtualKey(&mut virtual_key)?;
                    let Some(key) = key_name(virtual_key) else {
                        return Ok(());
                    };
                    let held = |virtual_key: i32| GetKeyState(virtual_key) < 0;
                    let press = KeyPress {
                        key,
                        ctrl: held(0x11),
                        alt: held(0x12),
                        shift: held(0x10),
                        repeat: status.WasKeyDown.as_bool(),
                    };
                    if on_key(press) {
                        args.SetHandled(true)?;
                    }
                    Ok(())
                },
            ));
            let mut token = 0;
            let _ = platform.controller().add_AcceleratorKeyPressed(&handler, &mut token);
        });
    }

    fn with_core(webview: &Webview, run: impl FnOnce(ICoreWebView2) + Send + 'static) {
        let _ = webview.with_webview(move |platform| unsafe {
            if let Ok(core) = platform.controller().CoreWebView2() {
                run(core);
            }
        });
    }

    pub fn back(webview: &Webview) {
        with_core(webview, |core| unsafe {
            let _ = core.GoBack();
        });
    }

    pub fn forward(webview: &Webview) {
        with_core(webview, |core| unsafe {
            let _ = core.GoForward();
        });
    }

    pub fn stop(webview: &Webview) {
        with_core(webview, |core| unsafe {
            let _ = core.Stop();
        });
    }

    pub fn devtools(webview: &Webview) {
        with_core(webview, |core| unsafe {
            let _ = core.OpenDevToolsWindow();
        });
    }

    /// Calls a Chrome DevTools Protocol method on the tab.
    async fn cdp(webview: &Webview, method: &str, params: Value) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel::<Result<String, String>>();
        let tx = Arc::new(Mutex::new(Some(tx)));
        let answer = move |tx: &Mutex<Option<oneshot::Sender<_>>>, result| {
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(result);
            }
        };
        let (method, params) = (method.to_owned(), params.to_string());
        let failed = Arc::clone(&tx);
        webview
            .with_webview(move |platform| unsafe {
                let done = Arc::clone(&tx);
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
                    answer(&done, result.map(|()| json).map_err(|e| e.message()));
                    Ok(())
                }));
                let called = platform.controller().CoreWebView2().and_then(|core| {
                    core.CallDevToolsProtocolMethod(&HSTRING::from(method), &HSTRING::from(params), &handler)
                });
                if let Err(e) = called {
                    answer(&tx, Err(e.message()));
                }
            })
            .map_err(|e| {
                drop(failed);
                e.to_string()
            })?;
        let json = tokio::time::timeout(Duration::from_secs(20), rx)
            .await
            .map_err(|_| "The page didn't answer in time.".to_owned())?
            .map_err(|_| "The tab closed.".to_owned())??;
        serde_json::from_str(&json).map_err(|e| e.to_string())
    }

    /// The tab's picture: PNG or JPEG bytes. It must be shown (or parked off
    /// screen): a hidden webview paints nothing.
    pub async fn screenshot(webview: &Webview, shot: Shot) -> Result<Vec<u8>, String> {
        let mut params = if shot.jpeg {
            json!({ "format": "jpeg", "quality": 82 })
        } else {
            json!({ "format": "png" })
        };
        let clip = match shot.clip {
            Some(clip) => Some(clip),
            None if shot.full_page => {
                let metrics = cdp(webview, "Page.getLayoutMetrics", json!({})).await?;
                let size = &metrics["cssContentSize"];
                Some(Clip {
                    x: 0.0,
                    y: 0.0,
                    width: size["width"].as_f64().unwrap_or(0.0),
                    height: size["height"].as_f64().unwrap_or(0.0).min(MAX_PAGE_HEIGHT),
                })
            }
            None => None,
        };
        if let Some(clip) = clip.filter(|c| c.width >= 1.0 && c.height >= 1.0) {
            params["captureBeyondViewport"] = json!(true);
            let scale = shot.scale.unwrap_or(1.0);
            params["clip"] = json!({ "x": clip.x, "y": clip.y, "width": clip.width, "height": clip.height, "scale": scale });
        }
        let shot = cdp(webview, "Page.captureScreenshot", params).await?;
        let data = shot["data"].as_str().ok_or("The page gave no picture.")?;
        base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    pub fn attach(_webview: &Webview, _on_history: impl Fn(String, bool, bool) + Send + 'static) {}

    pub fn watch_keys(_webview: &Webview, _on_key: impl Fn(KeyPress) -> bool + Send + 'static) {}

    pub fn back(webview: &Webview) {
        let _ = webview.eval("history.back()");
    }

    pub fn forward(webview: &Webview) {
        let _ = webview.eval("history.forward()");
    }

    pub fn stop(webview: &Webview) {
        let _ = webview.eval("window.stop()");
    }

    pub fn devtools(webview: &Webview) {
        #[cfg(debug_assertions)]
        webview.open_devtools();
        #[cfg(not(debug_assertions))]
        let _ = webview;
    }

    pub async fn screenshot(_webview: &Webview, _shot: Shot) -> Result<Vec<u8>, String> {
        Err("Screenshots of browser tabs aren't supported on this platform yet.".into())
    }
}
