//! Spawns and talks to the Node "desktop host" helper (apps/desktop-tauri/host),
//! which runs the desktop-only TypeScript (packages/ssh now; Tailscale and WSL
//! later) that the Electron main process ran in-process. The shell keeps
//! settings and backend supervision; the helper only answers requests.
//!
//! Newline-delimited JSON over stdio: requests `{id, method, params}`, replies
//! `{id, ok: true, value}` or `{id, ok: false, error: {message, tag?}}`, and
//! events `{event, payload}`, which reach the webview as `host:<event>`. The
//! helper starts on the first call and is started again by the next call
//! after it exits.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

use crate::backend::{forward_output, open_log};

pub struct HostConfig {
    pub node: PathBuf,
    pub entry: PathBuf,
    pub cwd: PathBuf,
    pub log_path: PathBuf,
}

/// What a failed call resolves to in the webview: the Tauri invoke rejects
/// with this object and the bridge turns it back into an `Error`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostError {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
}

impl HostError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            tag: None,
        }
    }
}

type Pending = Mutex<HashMap<u64, oneshot::Sender<Result<Value, HostError>>>>;

pub struct Host {
    config: HostConfig,
    next_id: AtomicU64,
    shared: Arc<Shared>,
}

/// Shared with the reader thread, which outlives any one call.
struct Shared {
    app: AppHandle,
    pending: Pending,
    running: Mutex<Option<Running>>,
}

struct Running {
    child: Child,
    stdin: ChildStdin,
    #[cfg(windows)]
    _job: crate::backend::job::Job,
}

enum Message {
    Reply {
        id: u64,
        result: Result<Value, HostError>,
    },
    Event {
        name: String,
        payload: Value,
    },
}

fn parse_message(line: &str) -> Option<Message> {
    let message: Value = serde_json::from_str(line).ok()?;
    if let Some(id) = message.get("id").and_then(Value::as_u64) {
        let result = if message.get("ok") == Some(&Value::Bool(true)) {
            Ok(message.get("value").cloned().unwrap_or(Value::Null))
        } else {
            Err(message
                .get("error")
                .cloned()
                .and_then(|error| serde_json::from_value(error).ok())
                .unwrap_or_else(|| HostError::new("The desktop host returned an error.")))
        };
        return Some(Message::Reply { id, result });
    }
    let name = message.get("event")?.as_str()?.to_owned();
    let payload = message.get("payload").cloned().unwrap_or(Value::Null);
    Some(Message::Event { name, payload })
}

impl Host {
    pub fn new(config: HostConfig, app: AppHandle) -> Self {
        Self {
            config,
            next_id: AtomicU64::new(1),
            shared: Arc::new(Shared {
                app,
                pending: Mutex::new(HashMap::new()),
                running: Mutex::new(None),
            }),
        }
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, HostError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        let request = serde_json::json!({ "id": id, "method": method, "params": params });
        {
            let mut running = self.shared.running.lock().unwrap();
            let exited = matches!(
                running.as_mut().map(|running| running.child.try_wait()),
                None | Some(Ok(Some(_))) | Some(Err(_))
            );
            if exited {
                *running = Some(self.spawn().map_err(|error| {
                    HostError::new(format!("Failed to start the desktop host: {error}"))
                })?);
            }
            // Registered before the write so a fast reply cannot arrive first.
            self.shared.pending.lock().unwrap().insert(id, sender);
            let stdin = &mut running.as_mut().expect("spawned above").stdin;
            if let Err(error) = writeln!(stdin, "{request}") {
                self.shared.pending.lock().unwrap().remove(&id);
                // The helper died under us; the next call starts a new one.
                if let Some(mut dead) = running.take() {
                    let _ = dead.child.kill();
                    let _ = dead.child.wait();
                }
                return Err(HostError::new(format!(
                    "Failed to send to the desktop host: {error}"
                )));
            }
        }
        receiver
            .await
            .unwrap_or_else(|_| Err(HostError::new("The desktop host exited before replying.")))
    }

    pub fn stop(&self) {
        if let Some(mut running) = self.shared.running.lock().unwrap().take() {
            let _ = running.child.kill();
            let _ = running.child.wait();
        }
    }

    fn spawn(&self) -> std::io::Result<Running> {
        let config = &self.config;
        let mut command = Command::new(&config.node);
        command
            .arg(&config.entry)
            .current_dir(&config.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn()?;
        // Same job object scheme as the backend: the helper and any ssh it
        // starts die with the app.
        #[cfg(windows)]
        let job = crate::backend::job::Job::new_kill_on_close()?;
        #[cfg(windows)]
        job.assign(&child)?;

        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        let log = open_log(&config.log_path);
        if let Some(log) = &log {
            let _ = writeln!(
                log.lock().unwrap(),
                "[desktop-tauri] starting host {} {} (pid {})",
                config.node.display(),
                config.entry.display(),
                child.id()
            );
        }
        forward_output("host", child.stderr.take(), log);

        let shared = Arc::clone(&self.shared);
        let pid = child.id();
        std::thread::Builder::new()
            .name("host-reader".into())
            .spawn(move || shared.read_until_exit(stdout, pid))
            .expect("spawn host reader");

        Ok(Running {
            child,
            stdin,
            #[cfg(windows)]
            _job: job,
        })
    }
}

impl Shared {
    fn read_until_exit(&self, stdout: impl std::io::Read, pid: u32) {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            match parse_message(&line) {
                Some(Message::Reply { id, result }) => {
                    if let Some(sender) = self.pending.lock().unwrap().remove(&id) {
                        let _ = sender.send(result);
                    }
                }
                Some(Message::Event { name, payload }) => {
                    if let Some(window) = self.app.get_webview_window("main") {
                        crate::emit_to_webview(&window, &format!("host:{name}"), payload);
                    }
                }
                None => eprintln!("[desktop-tauri] host sent a line that is not a message"),
            }
        }
        // EOF: the helper exited. Fail what is waiting, and clear the slot
        // unless a newer helper already took it.
        let pending: Vec<_> = self.pending.lock().unwrap().drain().collect();
        for (_, sender) in pending {
            let _ = sender.send(Err(HostError::new("The desktop host exited.")));
        }
        let mut running = self.running.lock().unwrap();
        if running.as_ref().map(|running| running.child.id()) == Some(pid) {
            if let Some(mut dead) = running.take() {
                let _ = dead.child.wait();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_success_and_error_replies() {
        let Some(Message::Reply { id, result }) =
            parse_message(r#"{"id":4,"ok":true,"value":[1]}"#)
        else {
            panic!("expected a reply");
        };
        assert_eq!(id, 4);
        assert_eq!(result.unwrap(), serde_json::json!([1]));

        let Some(Message::Reply { result, .. }) =
            parse_message(r#"{"id":5,"ok":false,"error":{"message":"no","tag":"X"}}"#)
        else {
            panic!("expected a reply");
        };
        let error = result.unwrap_err();
        assert_eq!(error.message, "no");
        assert_eq!(error.tag.as_deref(), Some("X"));

        // A void method's reply has no value; an error without a payload still fails.
        let Some(Message::Reply { result, .. }) = parse_message(r#"{"id":6,"ok":true}"#) else {
            panic!("expected a reply");
        };
        assert_eq!(result.unwrap(), Value::Null);
        let Some(Message::Reply { result, .. }) = parse_message(r#"{"id":7,"ok":false}"#) else {
            panic!("expected a reply");
        };
        assert!(result.is_err());
    }

    #[test]
    fn parses_events_and_rejects_noise() {
        let Some(Message::Event { name, payload }) =
            parse_message(r#"{"event":"ssh-password-prompt","payload":{"a":1}}"#)
        else {
            panic!("expected an event");
        };
        assert_eq!(name, "ssh-password-prompt");
        assert_eq!(payload, serde_json::json!({"a": 1}));
        assert!(parse_message("not json").is_none());
        assert!(parse_message(r#"{"hello":"world"}"#).is_none());
    }
}
