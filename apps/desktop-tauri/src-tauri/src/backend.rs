//! Launches and supervises the Node backend (`apps/server`), the same process
//! the Electron shell runs. The bootstrap envelope goes over stdin
//! (`--bootstrap-fd 0`), the delivery the Electron shell already uses for WSL.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use sha2::Sha256;

/// Matches DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS in @t3tools/shared/desktopBootstrapToken.
const BOOTSTRAP_TOKEN_WINDOW_MS: u128 = 12 * 60 * 60 * 1000;
const MAX_RESTART_DELAY: Duration = Duration::from_secs(30);
#[cfg(unix)]
const TERMINATE_GRACE: Duration = Duration::from_secs(5);

/// Inherited values that would override the bootstrap envelope. Mirrors
/// DESKTOP_BACKEND_ENV_NAMES in the Electron shell.
const CLEARED_ENV_NAMES: &[&str] = &[
    "T3CODE_PORT",
    "T3CODE_MODE",
    "T3CODE_NO_BROWSER",
    "T3CODE_HOST",
    "T3CODE_DESKTOP_WS_URL",
    "T3CODE_DESKTOP_LAN_ACCESS",
    "T3CODE_DESKTOP_LAN_HOST",
    "T3CODE_DESKTOP_HTTPS_ENDPOINTS",
    "T3CODE_TAILSCALE_SERVE",
    "T3CODE_TAILSCALE_SERVE_PORT",
];

pub struct BackendConfig {
    pub node: PathBuf,
    pub entry: PathBuf,
    pub cwd: PathBuf,
    pub port: u16,
    pub t3_home: PathBuf,
    pub log_path: PathBuf,
}

pub struct Backend {
    config: BackendConfig,
    secret: String,
    desired_running: AtomicBool,
    child: Mutex<Option<RunningChild>>,
}

struct RunningChild {
    child: Child,
    #[cfg(windows)]
    job: job::Job,
}

impl Backend {
    pub fn new(config: BackendConfig) -> Arc<Self> {
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).expect("OS random source unavailable");
        Arc::new(Self {
            config,
            secret: hex::encode(bytes),
            desired_running: AtomicBool::new(false),
            child: Mutex::new(None),
        })
    }

    pub fn http_base_url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.config.port)
    }

    pub fn ws_base_url(&self) -> String {
        format!("ws://127.0.0.1:{}/", self.config.port)
    }

    /// The token the renderer presents now. The backend derives the same
    /// value from the secret, so it rotates without talking to the backend.
    pub fn current_bootstrap_token(&self) -> String {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before 1970")
            .as_millis();
        let window = now / BOOTSTRAP_TOKEN_WINDOW_MS;
        let mut mac = Hmac::<Sha256>::new_from_slice(self.secret.as_bytes())
            .expect("HMAC accepts any key length");
        mac.update(format!("t3-desktop-bootstrap:{window}").as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    pub fn start(self: &Arc<Self>) {
        if self.desired_running.swap(true, Ordering::SeqCst) {
            return;
        }
        let backend = Arc::clone(self);
        std::thread::Builder::new()
            .name("backend-supervisor".into())
            .spawn(move || backend.supervise())
            .expect("spawn backend supervisor");
    }

    pub fn stop(&self) {
        self.desired_running.store(false, Ordering::SeqCst);
        if let Some(running) = self.child.lock().unwrap().take() {
            terminate(running);
        }
    }

    fn supervise(self: Arc<Self>) {
        let mut restart_delay = Duration::from_secs(1);
        while self.desired_running.load(Ordering::SeqCst) {
            let started = std::time::Instant::now();
            match self.spawn() {
                Ok(running) => {
                    *self.child.lock().unwrap() = Some(running);
                    let status = self.wait_for_exit();
                    if !self.desired_running.load(Ordering::SeqCst) {
                        return;
                    }
                    eprintln!("[desktop-tauri] backend exited ({status:?}); restarting in {restart_delay:?}");
                }
                Err(error) => {
                    eprintln!("[desktop-tauri] failed to start backend: {error}; retrying in {restart_delay:?}");
                }
            }
            // A backend that ran for a while crashed for a new reason; don't
            // make it wait out the backoff from an earlier crash loop.
            if started.elapsed() > Duration::from_secs(60) {
                restart_delay = Duration::from_secs(1);
            }
            std::thread::sleep(restart_delay);
            restart_delay = (restart_delay * 2).min(MAX_RESTART_DELAY);
        }
    }

    /// Polls rather than blocking in `wait()` so `stop()` can take the child
    /// out of the mutex and terminate it.
    fn wait_for_exit(&self) -> Option<std::process::ExitStatus> {
        loop {
            {
                let mut guard = self.child.lock().unwrap();
                match guard.as_mut() {
                    None => return None,
                    Some(running) => {
                        if let Ok(Some(status)) = running.child.try_wait() {
                            guard.take();
                            return Some(status);
                        }
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    fn spawn(&self) -> std::io::Result<RunningChild> {
        let config = &self.config;
        let mut command = Command::new(&config.node);
        command
            .arg(&config.entry)
            .args(["--bootstrap-fd", "0"])
            .current_dir(&config.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for name in CLEARED_ENV_NAMES {
            command.env_remove(name);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command.spawn()?;
        #[cfg(windows)]
        let job = job::Job::new_kill_on_close()?;
        #[cfg(windows)]
        job.assign(&child)?;

        let bootstrap = serde_json::json!({
            "mode": "desktop",
            "noBrowser": true,
            "port": config.port,
            "t3Home": config.t3_home,
            "host": "127.0.0.1",
            "desktopBootstrapToken": self.current_bootstrap_token(),
            "desktopBootstrapSecret": self.secret,
            "tailscaleServeEnabled": false,
            "tailscaleServePort": 443,
        });
        // Dropping stdin after the line closes the stream, which ends the
        // server's bootstrap read.
        let mut stdin = child.stdin.take().expect("stdin is piped");
        writeln!(stdin, "{bootstrap}")?;
        drop(stdin);

        let log = open_log(&config.log_path);
        if let Some(log) = &log {
            let _ = writeln!(
                log.lock().unwrap(),
                "[desktop-tauri] starting {} {} (cwd {})",
                config.node.display(),
                config.entry.display(),
                config.cwd.display()
            );
        }
        forward_output(child.stdout.take(), log.clone());
        forward_output(child.stderr.take(), log);

        Ok(RunningChild {
            child,
            #[cfg(windows)]
            job,
        })
    }
}

fn open_log(path: &PathBuf) -> Option<Arc<Mutex<std::fs::File>>> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
        .map(|file| Arc::new(Mutex::new(file)))
}

fn forward_output(
    stream: Option<impl std::io::Read + Send + 'static>,
    log: Option<Arc<Mutex<std::fs::File>>>,
) {
    let Some(stream) = stream else { return };
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            eprintln!("[backend] {line}");
            if let Some(log) = &log {
                let _ = writeln!(log.lock().unwrap(), "{line}");
            }
        }
    });
}

#[cfg(windows)]
fn terminate(running: RunningChild) {
    // Ends the backend and every provider CLI and terminal it started.
    running.job.terminate();
    let mut child = running.child;
    let _ = child.wait();
}

#[cfg(unix)]
fn terminate(running: RunningChild) {
    let mut child = running.child;
    // SIGTERM lets the server close its database and provider sessions.
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    let deadline = std::time::Instant::now() + TERMINATE_GRACE;
    while std::time::Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// A job object with KILL_ON_JOB_CLOSE, so the backend's process tree dies
/// with the app even if the app crashes before `stop()` runs.
#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);

    // The handle is only used through Win32 calls that are thread-safe.
    unsafe impl Send for Job {}

    impl Job {
        pub fn new_kill_on_close() -> std::io::Result<Self> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                let job = Self(handle);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(job)
            }
        }

        pub fn assign(&self, child: &std::process::Child) -> std::io::Result<()> {
            let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
            if ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
