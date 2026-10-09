mod backend;
mod commands;
mod host;
mod menu;
mod settings;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use backend::{Backend, BackendConfig};

const BRIDGE_SCRIPT: &str = include_str!("../../dist/bridge.iife.js");
const APP_BASE_NAME: &str = "T3 Code";
const DEFAULT_BACKEND_PORT: u16 = 3773;
// Electron's hiddenInset title bar: the traffic lights sit centered in the
// web app's 52px top bar (--workspace-topbar-height), 7px being their radius.
#[cfg(target_os = "macos")]
const MACOS_TRAFFIC_LIGHT_POSITION: (f64, f64) = (16.0, 52.0 / 2.0 - 7.0);

pub struct AppState {
    pub backend: Arc<Backend>,
    pub host: host::Host,
    pub paths: Paths,
    pub context_menus: commands::ContextMenus,
    pub zoom: menu::Zoom,
    fullscreen: AtomicBool,
    maximized: AtomicBool,
}

pub struct Paths {
    pub state_dir: PathBuf,
}

impl Paths {
    pub fn client_settings(&self) -> PathBuf {
        self.state_dir.join("client-settings.json")
    }

    pub fn desktop_settings(&self) -> PathBuf {
        self.state_dir.join("desktop-settings.json")
    }
}

/// Mirrors DesktopEnvironment in the Electron shell: dev mode is keyed off
/// VITE_DEV_SERVER_URL, and dev state lives under `<t3 home>/dev` unless
/// T3CODE_HOME is set explicitly. Both shells share these files, so switching
/// between them keeps settings and history.
struct Environment {
    is_development: bool,
    base_dir: PathBuf,
    state_dir: PathBuf,
}

impl Environment {
    fn resolve() -> Self {
        let is_development = env_non_empty("VITE_DEV_SERVER_URL").is_some();
        let configured_home = env_non_empty("T3CODE_HOME").map(PathBuf::from);
        let base_dir = configured_home
            .clone()
            .unwrap_or_else(|| home_dir().join(".t3"));
        let state_dir = base_dir.join(if is_development && configured_home.is_none() {
            "dev"
        } else {
            "userdata"
        });
        Self {
            is_development,
            base_dir,
            state_dir,
        }
    }
}

fn env_non_empty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn home_dir() -> PathBuf {
    let name = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    PathBuf::from(std::env::var_os(name).expect("home directory is not set"))
}

/// Mirrors the Electron shell's scan: a port is free only when every host can
/// bind it. On Windows a bind to 127.0.0.1 succeeds beside another process's
/// 0.0.0.0 listener (an installed T3 Code, say), and that listener then
/// answers the window's first requests with 401 until ours is up.
const PORT_PROBE_HOSTS: [&str; 3] = ["127.0.0.1", "0.0.0.0", "::"];

fn resolve_port() -> u16 {
    if let Some(port) = env_non_empty("T3CODE_PORT").and_then(|value| value.parse().ok()) {
        return port;
    }
    (DEFAULT_BACKEND_PORT..=u16::MAX)
        .find(|&port| PORT_PROBE_HOSTS.iter().all(|host| can_listen(host, port)))
        .expect("no free port for the backend")
}

fn can_listen(host: &str, port: u16) -> bool {
    match std::net::TcpListener::bind((host, port)) {
        Ok(_) => true,
        // A host this machine lacks (no IPv6) is not a conflict.
        Err(error) => error.kind() == std::io::ErrorKind::AddrNotAvailable,
    }
}

/// The Node processes this shell runs: the backend (`apps/server`) and the
/// desktop host helper (`apps/desktop-tauri/host`).
struct NodeLaunch {
    node: PathBuf,
    server_entry: PathBuf,
    host_entry: PathBuf,
    cwd: PathBuf,
}

/// Dev runs both from source, like `apps/server`'s own dev script. Packaged
/// builds run the Node sidecar beside the executable against the `server/`
/// and `host/` resource trees that scripts/build-desktop-tauri-artifact.ts
/// stages (on Windows all of it sits next to the exe). The server finds its
/// web client, resource monitor, and runtime externals relative to bin.mjs.
/// Every path can be overridden by env, which is how an unpackaged release
/// build can be pointed at a stage.
fn resolve_node_launch(app: &tauri::App, is_development: bool) -> NodeLaunch {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let defaults = if is_development {
        NodeLaunch {
            node: PathBuf::from("node"),
            server_entry: repo_root.join("apps/server/src/bin.ts"),
            host_entry: repo_root.join("apps/desktop-tauri/host/main.ts"),
            cwd: repo_root,
        }
    } else {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(PathBuf::from))
            .unwrap_or_default();
        let resources = strip_verbatim_prefix(app.path().resource_dir().unwrap_or_default());
        NodeLaunch {
            node: exe_dir.join(if cfg!(windows) { "node.exe" } else { "node" }),
            server_entry: resources.join("server/bin.mjs"),
            host_entry: resources.join("host/main.mjs"),
            cwd: home_dir(),
        }
    };
    NodeLaunch {
        node: env_non_empty("T3CODE_TAURI_NODE").map_or(defaults.node, PathBuf::from),
        server_entry: env_non_empty("T3CODE_TAURI_SERVER_ENTRY")
            .map_or(defaults.server_entry, PathBuf::from),
        host_entry: env_non_empty("T3CODE_TAURI_HOST_ENTRY")
            .map_or(defaults.host_entry, PathBuf::from),
        cwd: defaults.cwd,
    }
}

/// Tauri canonicalizes the executable path, which on Windows produces a
/// `\\?\C:\...` verbatim path. Node cannot load a main module from one
/// (`realpathSync` fails on the `C:` component), so hand it a plain path.
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

fn platform_name() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

fn host_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => "other",
    }
}

fn initialization_script(
    environment: &Environment,
    backend: &Backend,
    app_version: &str,
    local_environment_enabled: bool,
) -> String {
    let stage_label = if environment.is_development {
        "Dev"
    } else {
        "Alpha"
    };
    let init = serde_json::json!({
        "branding": {
            "baseName": APP_BASE_NAME,
            "stageLabel": stage_label,
            "displayName": format!("{APP_BASE_NAME} ({stage_label})"),
        },
        "platform": platform_name(),
        "locale": sys_locale::get_locale(),
        "appVersion": app_version,
        "hostArch": host_arch(),
        "localEnvironmentEnabled": local_environment_enabled,
        "bootstraps": [{
            "id": "primary",
            "label": "Local",
            "runningDistro": null,
            "httpBaseUrl": backend.http_base_url(),
            "wsBaseUrl": backend.ws_base_url(),
            "bootstrapToken": backend.current_bootstrap_token(),
        }],
    });
    format!("window.__T3_TAURI_INIT__ = {init};\n{BRIDGE_SCRIPT}")
}

pub(crate) fn emit_to_webview(
    window: &tauri::WebviewWindow,
    event: &str,
    payload: serde_json::Value,
) {
    let script = format!(
        "window.__t3TauriEmit && window.__t3TauriEmit({}, {payload});",
        serde_json::Value::String(event.to_owned())
    );
    let _ = window.eval(&script);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::current_bootstrap_token,
            commands::get_client_settings,
            commands::set_client_settings,
            commands::set_local_environment_enabled,
            commands::get_server_exposure_settings,
            commands::set_server_exposure_mode,
            commands::set_tailscale_serve_enabled,
            commands::pick_folder,
            commands::pick_project_favicon,
            commands::pick_theme_files,
            commands::set_theme,
            commands::show_context_menu,
            commands::open_external,
            commands::set_notification_badge,
            commands::drag_window,
            commands::minimize_window,
            commands::toggle_maximize_window,
            commands::close_window,
            commands::host_call,
        ])
        .on_menu_event(|app, event| {
            menu::handle_menu_event(app, &event);
            commands::handle_menu_event(app, event);
        })
        .setup(|app| {
            let environment = Environment::resolve();
            let launch = resolve_node_launch(app, environment.is_development);
            let paths = Paths {
                state_dir: environment.state_dir.clone(),
            };
            // Unlike the Electron shell, a persisted network-accessible mode
            // binds 0.0.0.0 even when no LAN address is up right now; the
            // address is advertised as soon as one appears, without a
            // restart.
            let backend = Backend::new(
                BackendConfig {
                    node: launch.node.clone(),
                    entry: launch.server_entry,
                    cwd: launch.cwd.clone(),
                    port: resolve_port(),
                    t3_home: environment.base_dir.clone(),
                    log_path: environment.state_dir.join("logs/desktop-tauri-backend.log"),
                },
                settings::read_server_exposure(&paths),
            );
            let version = app.package_info().version.to_string();
            let host = host::Host::new(
                host::HostConfig {
                    node: launch.node,
                    entry: launch.host_entry,
                    cwd: launch.cwd,
                    log_path: environment.state_dir.join("logs/desktop-tauri-host.log"),
                    app_version: version.clone(),
                },
                app.handle().clone(),
            );
            let local_environment_enabled = settings::local_environment_enabled(&paths);
            if local_environment_enabled {
                backend.start();
            }

            let script =
                initialization_script(&environment, &backend, &version, local_environment_enabled);
            let title = if environment.is_development {
                format!("{APP_BASE_NAME} (Dev)")
            } else {
                format!("{APP_BASE_NAME} (Alpha)")
            };

            app.manage(AppState {
                backend,
                host,
                paths,
                context_menus: Default::default(),
                zoom: Default::default(),
                fullscreen: AtomicBool::new(false),
                maximized: AtomicBool::new(false),
            });

            // Set before the window exists so Tauri attaches it (and its
            // accelerator table) to the window on creation.
            app.set_menu(menu::build(app.handle(), &title)?)?;

            let builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title(&title)
                    .inner_size(1280.0, 832.0)
                    .min_inner_size(840.0, 560.0)
                    .initialization_script(&script)
                    .on_page_load(|window, payload| {
                        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                            let factor = window.state::<AppState>().zoom.factor();
                            menu::emit_zoom(&window, factor);
                            // The bridge script is static, so a reload of a
                            // maximized window learns the state from here.
                            let maximized = window.is_maximized().unwrap_or(false);
                            emit_to_webview(&window, "maximized", maximized.into());
                            // A reload drops the page that showed any SSH
                            // password prompt; fail those so the connect
                            // attempt ends instead of waiting out its
                            // timeout. Only a running helper can hold one.
                            let app = window.app_handle().clone();
                            if app.state::<AppState>().host.is_running() {
                                tauri::async_runtime::spawn(async move {
                                    let state = app.state::<AppState>();
                                    let _ = state
                                        .host
                                        .call("abandonSshPasswordPrompts", serde_json::Value::Null)
                                        .await;
                                });
                            }
                        }
                    });
            // Windows: no native frame, like Electron's titleBarStyle "hidden".
            // The web app draws the caption buttons (bridge `windowControls`)
            // since WebView2 has no window-controls overlay. tao keeps the
            // resize borders and DWM shadow of an undecorated window
            // (WM_NCCALCSIZE/WM_NCHITTEST in tao's windows event_loop.rs).
            // Linux keeps native decorations: WebKitGTK ignores app-region, so
            // a frameless window there would also need the macOS drag shim.
            #[cfg(target_os = "windows")]
            let builder = builder.decorations(false).shadow(true);
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(
                    MACOS_TRAFFIC_LIGHT_POSITION.0,
                    MACOS_TRAFFIC_LIGHT_POSITION.1,
                ));
            let window = builder.build()?;
            // Electron hides the bar (autoHideMenuBar); see menu.rs.
            if !cfg!(target_os = "macos") {
                window.hide_menu()?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Resized(_) = event {
                let Some(webview) = window.app_handle().get_webview_window(window.label()) else {
                    return;
                };
                let state = window.state::<AppState>();
                let fullscreen = window.is_fullscreen().unwrap_or(false);
                if state.fullscreen.swap(fullscreen, Ordering::SeqCst) != fullscreen {
                    emit_to_webview(&webview, "fullscreen", fullscreen.into());
                }
                // Maximize and restore both arrive as resizes.
                let maximized = window.is_maximized().unwrap_or(false);
                if state.maximized.swap(maximized, Ordering::SeqCst) != maximized {
                    emit_to_webview(&webview, "maximized", maximized.into());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Tauri application");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            let state = app.state::<AppState>();
            state.backend.stop();
            state.host.stop();
        }
    });
}
