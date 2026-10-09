//! Reads and writes the same settings files as the Electron shell's
//! DesktopClientSettings and DesktopAppSettings.

use std::path::Path;

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
