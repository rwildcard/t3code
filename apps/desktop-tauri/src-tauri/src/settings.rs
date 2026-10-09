//! Reads and writes the same settings files as the Electron shell's
//! DesktopClientSettings and DesktopAppSettings.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::Paths;

fn read_json(path: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Temp file + rename, so a crash mid-write never leaves a truncated file.
fn write_json(path: &Path, value: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&temp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(&temp, path)
}

/// Older files wrap the settings in `{ "settings": ... }`.
pub fn read_client_settings(paths: &Paths) -> Option<Value> {
    let document = read_json(&paths.client_settings())?;
    match document {
        Value::Object(mut object) if object.contains_key("settings") => object.remove("settings"),
        other => Some(other),
    }
}

pub fn write_client_settings(paths: &Paths, settings: &Value) -> std::io::Result<()> {
    write_json(&paths.client_settings(), settings)
}

fn read_desktop_settings(paths: &Paths) -> Map<String, Value> {
    match read_json(&paths.desktop_settings()) {
        Some(Value::Object(object)) => object,
        _ => Map::new(),
    }
}

pub fn local_environment_enabled(paths: &Paths) -> bool {
    read_desktop_settings(paths).get("localEnvironmentEnabled") != Some(&Value::Bool(false))
}

/// The document is sparse: a value equal to its default is omitted. Other
/// keys belong to settings this shell does not manage yet and are kept.
pub fn set_local_environment_enabled(paths: &Paths, enabled: bool) -> std::io::Result<()> {
    let mut document = read_desktop_settings(paths);
    if enabled {
        document.remove("localEnvironmentEnabled");
    } else {
        document.insert("localEnvironmentEnabled".into(), Value::Bool(false));
    }
    write_json(&paths.desktop_settings(), &Value::Object(document))
}

/// The network exposure keys of desktop-settings.json, with the defaults and
/// normalization of DesktopAppSettings.ts: an unknown mode reads as
/// local-only, Serve is on only when the key is `true`, and a port outside
/// 1..=65535 (or not an integer) falls back to 443.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ServerExposureMode {
    LocalOnly,
    NetworkAccessible,
}

pub const DEFAULT_TAILSCALE_SERVE_PORT: u16 = 443;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerExposure {
    pub mode: ServerExposureMode,
    pub tailscale_serve_enabled: bool,
    pub tailscale_serve_port: u16,
}

impl Default for ServerExposure {
    fn default() -> Self {
        Self {
            mode: ServerExposureMode::LocalOnly,
            tailscale_serve_enabled: false,
            tailscale_serve_port: DEFAULT_TAILSCALE_SERVE_PORT,
        }
    }
}

impl ServerExposure {
    /// What the backend binds; the advertised LAN address is resolved by the
    /// desktop host helper, which can enumerate interfaces.
    pub fn bind_host(&self) -> &'static str {
        match self.mode {
            ServerExposureMode::LocalOnly => "127.0.0.1",
            ServerExposureMode::NetworkAccessible => "0.0.0.0",
        }
    }
}

pub fn normalize_tailscale_serve_port(value: Option<&Value>) -> u16 {
    value
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port >= 1)
        .unwrap_or(DEFAULT_TAILSCALE_SERVE_PORT)
}

fn server_exposure_from_document(document: &Map<String, Value>) -> ServerExposure {
    ServerExposure {
        mode: if document.get("serverExposureMode").and_then(Value::as_str)
            == Some("network-accessible")
        {
            ServerExposureMode::NetworkAccessible
        } else {
            ServerExposureMode::LocalOnly
        },
        tailscale_serve_enabled: document.get("tailscaleServeEnabled") == Some(&Value::Bool(true)),
        tailscale_serve_port: normalize_tailscale_serve_port(document.get("tailscaleServePort")),
    }
}

pub fn read_server_exposure(paths: &Paths) -> ServerExposure {
    server_exposure_from_document(&read_desktop_settings(paths))
}

/// Sparse like the rest of the document: a key at its default is removed.
pub fn write_server_exposure(paths: &Paths, exposure: ServerExposure) -> std::io::Result<()> {
    let defaults = ServerExposure::default();
    let mut document = read_desktop_settings(paths);
    if exposure.mode == defaults.mode {
        document.remove("serverExposureMode");
    } else {
        document.insert(
            "serverExposureMode".into(),
            serde_json::to_value(exposure.mode).expect("mode serializes"),
        );
    }
    if exposure.tailscale_serve_enabled == defaults.tailscale_serve_enabled {
        document.remove("tailscaleServeEnabled");
    } else {
        document.insert(
            "tailscaleServeEnabled".into(),
            Value::Bool(exposure.tailscale_serve_enabled),
        );
    }
    if exposure.tailscale_serve_port == defaults.tailscale_serve_port {
        document.remove("tailscaleServePort");
    } else {
        document.insert(
            "tailscaleServePort".into(),
            Value::from(exposure.tailscale_serve_port),
        );
    }
    write_json(&paths.desktop_settings(), &Value::Object(document))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_paths(name: &str) -> Paths {
        let state_dir = std::env::temp_dir().join(format!(
            "t3-desktop-tauri-settings-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&state_dir).unwrap();
        Paths { state_dir }
    }

    #[test]
    fn reads_defaults_when_keys_are_missing_or_invalid() {
        let paths = temp_paths("defaults");
        assert_eq!(read_server_exposure(&paths), ServerExposure::default());

        std::fs::write(
            paths.desktop_settings(),
            r#"{"serverExposureMode":"bogus","tailscaleServeEnabled":"yes","tailscaleServePort":70000}"#,
        )
        .unwrap();
        assert_eq!(read_server_exposure(&paths), ServerExposure::default());

        std::fs::write(
            paths.desktop_settings(),
            r#"{"serverExposureMode":"network-accessible","tailscaleServeEnabled":true,"tailscaleServePort":8443}"#,
        )
        .unwrap();
        assert_eq!(
            read_server_exposure(&paths),
            ServerExposure {
                mode: ServerExposureMode::NetworkAccessible,
                tailscale_serve_enabled: true,
                tailscale_serve_port: 8443,
            }
        );
        std::fs::remove_dir_all(&paths.state_dir).unwrap();
    }

    #[test]
    fn normalizes_serve_ports_like_the_electron_shell() {
        assert_eq!(normalize_tailscale_serve_port(None), 443);
        assert_eq!(normalize_tailscale_serve_port(Some(&Value::from(0))), 443);
        assert_eq!(
            normalize_tailscale_serve_port(Some(&Value::from(65536))),
            443
        );
        assert_eq!(normalize_tailscale_serve_port(Some(&Value::from(-1))), 443);
        assert_eq!(normalize_tailscale_serve_port(Some(&Value::from(1.5))), 443);
        assert_eq!(
            normalize_tailscale_serve_port(Some(&Value::from("8443"))),
            443
        );
        assert_eq!(normalize_tailscale_serve_port(Some(&Value::from(1))), 1);
        assert_eq!(
            normalize_tailscale_serve_port(Some(&Value::from(65535))),
            65535
        );
    }

    #[test]
    fn writes_a_sparse_document_and_keeps_foreign_keys() {
        let paths = temp_paths("sparse");
        std::fs::write(
            paths.desktop_settings(),
            r#"{"localEnvironmentEnabled":false,"updateChannel":"nightly"}"#,
        )
        .unwrap();

        write_server_exposure(
            &paths,
            ServerExposure {
                mode: ServerExposureMode::NetworkAccessible,
                tailscale_serve_enabled: true,
                tailscale_serve_port: 8443,
            },
        )
        .unwrap();
        let document = read_desktop_settings(&paths);
        assert_eq!(
            document.get("serverExposureMode"),
            Some(&Value::from("network-accessible"))
        );
        assert_eq!(
            document.get("tailscaleServeEnabled"),
            Some(&Value::Bool(true))
        );
        assert_eq!(document.get("tailscaleServePort"), Some(&Value::from(8443)));
        assert_eq!(
            document.get("localEnvironmentEnabled"),
            Some(&Value::Bool(false))
        );
        assert_eq!(document.get("updateChannel"), Some(&Value::from("nightly")));

        write_server_exposure(&paths, ServerExposure::default()).unwrap();
        let document = read_desktop_settings(&paths);
        assert!(!document.contains_key("serverExposureMode"));
        assert!(!document.contains_key("tailscaleServeEnabled"));
        assert!(!document.contains_key("tailscaleServePort"));
        assert_eq!(
            document.get("localEnvironmentEnabled"),
            Some(&Value::Bool(false))
        );
        std::fs::remove_dir_all(&paths.state_dir).unwrap();
    }
}
