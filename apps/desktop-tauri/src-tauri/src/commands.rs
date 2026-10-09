use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::menu::{
    CheckMenuItemBuilder, IsMenuItem, Menu, MenuEvent, MenuItemBuilder, PredefinedMenuItem, Submenu,
};
use tauri::window::Color;
use tauri::{AppHandle, Runtime, State, Theme, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

use crate::{host, settings, AppState};

type CommandResult<T> = Result<T, String>;

fn to_message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[tauri::command]
pub fn current_bootstrap_token(state: State<'_, AppState>) -> String {
    state.backend.current_bootstrap_token()
}

#[tauri::command]
pub fn get_client_settings(state: State<'_, AppState>) -> Option<Value> {
    settings::read_client_settings(&state.paths)
}

#[tauri::command]
pub fn set_client_settings(state: State<'_, AppState>, settings: Value) -> CommandResult<()> {
    settings::write_client_settings(&state.paths, &settings).map_err(to_message)
}

#[tauri::command]
pub fn set_local_environment_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> CommandResult<()> {
    settings::set_local_environment_enabled(&state.paths, enabled).map_err(to_message)?;
    if enabled {
        state.backend.start();
    } else {
        state.backend.stop();
    }
    Ok(())
}

#[tauri::command]
pub async fn pick_folder(
    app: AppHandle,
    window: WebviewWindow,
    initial_path: Option<String>,
) -> CommandResult<Option<String>> {
    let mut dialog = app.dialog().file().set_parent(&window);
    if let Some(path) = initial_path.filter(|path| !path.is_empty()) {
        dialog = dialog.set_directory(path);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
        .await
        .map_err(to_message)?;
    Ok(picked
        .and_then(|path| path.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned()))
}

/// Same list as WORKSPACE_IMAGE_PREVIEW_EXTENSIONS, which the Electron picker uses.
const FAVICON_EXTENSIONS: &[&str] = &["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"];

#[tauri::command]
pub async fn pick_project_favicon(
    app: AppHandle,
    window: WebviewWindow,
    initial_path: Option<String>,
) -> CommandResult<Option<String>> {
    let mut dialog = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("Images", FAVICON_EXTENSIONS);
    if let Some(path) = initial_path.filter(|path| !path.is_empty()) {
        dialog = dialog.set_directory(path);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
        .await
        .map_err(to_message)?;
    Ok(picked
        .and_then(|path| path.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned()))
}

#[derive(Serialize)]
pub struct PickedThemeFile {
    name: String,
    size: u64,
    text: String,
}

#[tauri::command]
pub async fn pick_theme_files(
    app: AppHandle,
    window: WebviewWindow,
) -> CommandResult<Option<Vec<PickedThemeFile>>> {
    let mut dialog = app
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("Theme", &["json"]);
    // VS Code themes ship inside extensions; start there when it exists.
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
    if let Some(extensions) = home
        .map(|home| PathBuf::from(home).join(".vscode").join("extensions"))
        .filter(|path| path.is_dir())
    {
        dialog = dialog.set_directory(extensions);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_files())
        .await
        .map_err(to_message)?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let mut files = Vec::with_capacity(picked.len());
    for path in picked {
        let path = path.into_path().map_err(to_message)?;
        let text = std::fs::read_to_string(&path).map_err(to_message)?;
        files.push(PickedThemeFile {
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            size: text.len() as u64,
            text,
        });
    }
    Ok(Some(files))
}

/// Besides the native frame's light/dark mode (and the menu's, on Windows),
/// this sets the same window background the Electron shell uses so resizes
/// and reloads do not flash the wrong color.
#[tauri::command]
pub fn set_theme(window: WebviewWindow, theme: String) -> CommandResult<()> {
    let theme = match theme.as_str() {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    };
    window.set_theme(theme).map_err(to_message)?;
    let dark = match theme {
        Some(theme) => theme == Theme::Dark,
        None => window.theme().map_err(to_message)? == Theme::Dark,
    };
    let color = if dark {
        Color(10, 10, 10, 255)
    } else {
        Color(255, 255, 255, 255)
    };
    window.set_background_color(Some(color)).map_err(to_message)
}

/// macOS only: WKWebView ignores `-webkit-app-region`, so the bridge starts
/// the drag for the web app's `.drag-region` elements itself. WebView2 handles
/// drag and double-click-to-maximize natively for those elements.
#[tauri::command]
pub fn drag_window(window: WebviewWindow, maximize: bool) -> CommandResult<()> {
    if !maximize {
        return window.start_dragging().map_err(to_message);
    }
    if window.is_maximized().map_err(to_message)? {
        window.unmaximize()
    } else {
        window.maximize()
    }
    .map_err(to_message)
}

/// Windows only: the window is undecorated there and the web app draws the
/// caption buttons (see `windowControls` in the bridge).
#[tauri::command]
pub fn minimize_window(window: WebviewWindow) -> CommandResult<()> {
    window.minimize().map_err(to_message)
}

#[tauri::command]
pub fn toggle_maximize_window(window: WebviewWindow) -> CommandResult<()> {
    drag_window(window, true)
}

/// Goes through the regular close path so the app exits as it does from the
/// native close button and the backend is stopped on `RunEvent::Exit`.
#[tauri::command]
pub fn close_window(window: WebviewWindow) -> CommandResult<()> {
    window.close().map_err(to_message)
}

/// Forwards a bridge method to the desktop host helper; see host.rs.
#[tauri::command]
pub async fn host_call(
    state: State<'_, AppState>,
    method: String,
    params: Value,
) -> Result<Value, host::HostError> {
    state.host.call(&method, params).await
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> bool {
    let allowed = ["http://", "https://", "mailto:"]
        .iter()
        .any(|scheme| url.to_ascii_lowercase().starts_with(scheme));
    allowed && app.opener().open_url(url, None::<&str>).is_ok()
}

/// Badge counts exist on macOS and some Linux desktops. Windows needs an
/// overlay icon instead, which this shell does not draw yet.
#[tauri::command]
pub fn set_notification_badge(window: WebviewWindow, count: i64) {
    let _ = window.set_badge_count(if count > 0 { Some(count) } else { None });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenuItem {
    id: String,
    label: String,
    #[serde(default)]
    disabled: bool,
    #[serde(default)]
    separator_before: bool,
    checked: Option<bool>,
    children: Option<Vec<ContextMenuItem>>,
}

#[derive(Deserialize)]
pub struct MenuPosition {
    x: f64,
    y: f64,
}

/// One native context menu is open at a time. A newer request replaces an
/// older one, whose sender is dropped and resolves as "nothing picked".
#[derive(Default)]
pub struct ContextMenus {
    next_id: AtomicU64,
    pending: Mutex<Option<(u64, oneshot::Sender<Option<String>>)>>,
}

impl ContextMenus {
    fn resolve(&self, request: u64, selection: Option<String>) {
        let mut pending = self.pending.lock().unwrap();
        if matches!(pending.as_ref(), Some((id, _)) if *id == request) {
            let (_, sender) = pending.take().unwrap();
            let _ = sender.send(selection);
        }
    }
}

const CONTEXT_MENU_ID_PREFIX: &str = "t3-context:";

fn append_items<R: Runtime>(
    app: &AppHandle<R>,
    request: u64,
    items: &[ContextMenuItem],
    append: &dyn Fn(&dyn IsMenuItem<R>) -> tauri::Result<()>,
) -> tauri::Result<()> {
    for (index, item) in items.iter().enumerate() {
        if item.separator_before && index > 0 {
            append(&PredefinedMenuItem::separator(app)?)?;
        }
        if let Some(children) = &item.children {
            let submenu = Submenu::new(app, &item.label, !item.disabled)?;
            append_items(app, request, children, &|child| submenu.append(child))?;
            append(&submenu)?;
            continue;
        }
        let id = format!("{CONTEXT_MENU_ID_PREFIX}{request}:{}", item.id);
        match item.checked {
            Some(checked) => append(
                &CheckMenuItemBuilder::with_id(id, &item.label)
                    .checked(checked)
                    .enabled(!item.disabled)
                    .build(app)?,
            )?,
            None => append(
                &MenuItemBuilder::with_id(id, &item.label)
                    .enabled(!item.disabled)
                    .build(app)?,
            )?,
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn show_context_menu(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    items: Vec<ContextMenuItem>,
    position: Option<MenuPosition>,
) -> CommandResult<Option<String>> {
    let menus = &state.context_menus;
    let request = menus.next_id.fetch_add(1, Ordering::SeqCst);
    let (sender, receiver) = oneshot::channel();
    *menus.pending.lock().unwrap() = Some((request, sender));

    let menu = Menu::new(&app).map_err(to_message)?;
    append_items(&app, request, &items, &|item| menu.append(item)).map_err(to_message)?;
    // Blocks until the popup closes on Windows and macOS.
    tauri::async_runtime::spawn_blocking(move || match position {
        Some(position) => {
            window.popup_menu_at(&menu, tauri::LogicalPosition::new(position.x, position.y))
        }
        None => window.popup_menu(&menu),
    })
    .await
    .map_err(to_message)?
    .map_err(to_message)?;

    // On Windows and macOS the popup call returns once the menu closes, but
    // the click arrives as a menu event the event loop has yet to process.
    // Queueing the "dismissed" resolution on the same loop orders it after
    // that event. GTK menus do not block, so there a dismissal stays pending
    // until the next menu replaces it.
    if !cfg!(target_os = "linux") {
        let app_for_dismiss = app.clone();
        let _ = app.run_on_main_thread(move || {
            let state = tauri::Manager::state::<AppState>(&app_for_dismiss);
            state.context_menus.resolve(request, None);
        });
    }

    Ok(receiver.await.unwrap_or(None))
}

pub fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    let Some(rest) = event.id().as_ref().strip_prefix(CONTEXT_MENU_ID_PREFIX) else {
        return;
    };
    let Some((request, item)) = rest.split_once(':') else {
        return;
    };
    if let Ok(request) = request.parse() {
        let state = tauri::Manager::state::<AppState>(app);
        state.context_menus.resolve(request, Some(item.to_owned()));
    }
}
