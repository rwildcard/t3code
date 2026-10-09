//! The application menu, mirroring apps/desktop/src/window/DesktopApplicationMenu.ts.
//!
//! Native roles map to Tauri's predefined items. Items the Electron shell
//! routes to the renderer are emitted as "menu-action" events; the rest act on
//! the main window here. Electron hides the menu bar on Windows and Linux
//! (`autoHideMenuBar`), so this shell hides it too; the accelerators keep
//! working because Tauri translates them from the app-wide accelerator table,
//! not from the visible bar.

use std::sync::Mutex;

use tauri::menu::{IsMenuItem, Menu, MenuEvent, MenuItemBuilder, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::{emit_to_webview, AppState};

const MENU_ID_PREFIX: &str = "t3-menu:";

// Chromium's zoom levels: factor = 1.2^level, and the Electron zoom roles
// step by half a level. The bounds keep the factor within Chromium's 25%-500%.
const ZOOM_STEP: f64 = 0.5;
const MIN_ZOOM_LEVEL: f64 = -7.5;
const MAX_ZOOM_LEVEL: f64 = 8.5;

#[derive(Default)]
pub struct Zoom {
    level: Mutex<f64>,
}

impl Zoom {
    pub fn factor(&self) -> f64 {
        1.2f64.powf(*self.level.lock().unwrap())
    }
}

fn id(action: &str) -> String {
    format!("{MENU_ID_PREFIX}{action}")
}

/// Only macOS labels carry the app name; Electron's other platforms do not.
pub fn build(
    app: &AppHandle,
    #[cfg_attr(not(target_os = "macos"), allow(unused_variables))] display_name: &str,
) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    let settings = MenuItemBuilder::with_id(id("open-settings"), "Settings...")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let check_for_updates =
        MenuItemBuilder::with_id(id("check-for-updates"), "Check for Updates...").build(app)?;

    #[cfg(target_os = "macos")]
    {
        let version = app.package_info().version.to_string();
        let about = tauri::menu::AboutMetadataBuilder::new()
            .name(Some(display_name))
            .version(Some(version))
            .build();
        menu.append(&Submenu::with_items(
            app,
            display_name,
            true,
            &[
                &PredefinedMenuItem::about(
                    app,
                    Some(&format!("About {display_name}")),
                    Some(about),
                )?,
                &check_for_updates,
                &PredefinedMenuItem::separator(app)?,
                &settings,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::services(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, Some(&format!("Hide {display_name}")))?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, Some(&format!("Quit {display_name}")))?,
            ],
        )?)?;
        menu.append(&Submenu::with_items(
            app,
            "File",
            true,
            &[&PredefinedMenuItem::close_window(app, None)?],
        )?)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        menu.append(&Submenu::with_items(
            app,
            "File",
            true,
            &[
                &settings,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?)?;
    }

    // No "Paste as Text" item: the Electron one only exists so a click can
    // call webContents.pasteAndMatchStyle, which Tauri has no equivalent for.
    // The chord itself is the webview's own plain-text paste.
    menu.append(&Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?)?;

    let devtools_accelerator = if cfg!(target_os = "macos") {
        "Alt+Cmd+I"
    } else {
        "Ctrl+Shift+I"
    };
    // The predefined fullscreen item is macOS-only; elsewhere Electron binds F11.
    let fullscreen: Box<dyn IsMenuItem<tauri::Wry>> = if cfg!(target_os = "macos") {
        Box::new(PredefinedMenuItem::fullscreen(app, None)?)
    } else {
        Box::new(
            MenuItemBuilder::with_id(id("toggle-fullscreen"), "Toggle Full Screen")
                .accelerator("F11")
                .build(app)?,
        )
    };
    menu.append(&Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItemBuilder::with_id(id("reload"), "Reload")
                .accelerator("CmdOrCtrl+R")
                .build(app)?,
            &MenuItemBuilder::with_id(id("force-reload"), "Force Reload")
                .accelerator("Shift+CmdOrCtrl+R")
                .build(app)?,
            &MenuItemBuilder::with_id(id("toggle-devtools"), "Toggle Developer Tools")
                .accelerator(devtools_accelerator)
                .build(app)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItemBuilder::with_id(id("zoom-reset"), "Actual Size")
                .accelerator("CmdOrCtrl+0")
                .build(app)?,
            &MenuItemBuilder::with_id(id("zoom-in"), "Zoom In")
                .accelerator("CmdOrCtrl+=")
                .build(app)?,
            &MenuItemBuilder::with_id(id("zoom-out"), "Zoom Out")
                .accelerator("CmdOrCtrl+-")
                .build(app)?,
            &PredefinedMenuItem::separator(app)?,
            fullscreen.as_ref(),
        ],
    )?)?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            &PredefinedMenuItem::separator(app)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::bring_all_to_front(app, None)?,
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let help_menu = Submenu::with_items(app, "Help", true, &[&check_for_updates])?;
    #[cfg(target_os = "macos")]
    {
        window_menu.set_as_windows_menu_for_nsapp()?;
        help_menu.set_as_help_menu_for_nsapp()?;
    }
    menu.append_items(&[&window_menu, &help_menu])?;
    Ok(menu)
}

pub fn handle_menu_event(app: &AppHandle, event: &MenuEvent) {
    let Some(action) = event.id().as_ref().strip_prefix(MENU_ID_PREFIX) else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    match action {
        "open-settings" => {
            emit_to_webview(&window, "menu-action", action.into());
            let _ = window.show();
            let _ = window.set_focus();
        }
        "check-for-updates" => app
            .dialog()
            .message("Automatic updates are not available in the Tauri desktop build yet.")
            .title("Updates unavailable")
            .kind(MessageDialogKind::Info)
            .show(|_| {}),
        // Tauri exposes no cache-bypassing reload, so both items reload plainly.
        "reload" | "force-reload" => {
            let _ = window.reload();
        }
        "toggle-devtools" => {
            if window.is_devtools_open() {
                window.close_devtools();
            } else {
                window.open_devtools();
            }
        }
        "zoom-reset" => zoom(&window, None),
        "zoom-in" => zoom(&window, Some(ZOOM_STEP)),
        "zoom-out" => zoom(&window, Some(-ZOOM_STEP)),
        "toggle-fullscreen" => {
            let fullscreen = window.is_fullscreen().unwrap_or(false);
            let _ = window.set_fullscreen(!fullscreen);
        }
        _ => {}
    }
}

fn zoom(window: &WebviewWindow, step: Option<f64>) {
    let state = window.state::<AppState>();
    let factor = {
        let mut level = state.zoom.level.lock().unwrap();
        *level = match step {
            Some(step) => (*level + step).clamp(MIN_ZOOM_LEVEL, MAX_ZOOM_LEVEL),
            None => 0.0,
        };
        1.2f64.powf(*level)
    };
    if window.set_zoom(factor).is_ok() {
        emit_zoom(window, factor);
    }
}

/// The page reserves space for the macOS window buttons in native points, so
/// it needs the factor after every zoom change and on every load.
pub fn emit_zoom(window: &WebviewWindow, factor: f64) {
    emit_to_webview(window, "zoom", factor.into());
}
