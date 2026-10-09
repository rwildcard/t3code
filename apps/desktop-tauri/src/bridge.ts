// @effect-diagnostics globalDate:off globalFetch:off globalTimers:off - Injected before page scripts, outside any Effect runtime; bundling Effect here would load it twice per page.
import type {
  ContextMenuItem,
  DesktopAppBranding,
  DesktopBridge,
  DesktopEnvironmentBootstrap,
  DesktopServerExposureMode,
  DesktopServerExposureState,
  DesktopUpdateState,
  DesktopWslState,
  PickedThemeFile,
} from "@t3tools/contracts";

/**
 * `window.desktopBridge` for the Tauri shell. The web app treats the bridge's
 * presence as "running in the desktop app" and feature-detects optional
 * members, so anything not listed here is hidden rather than broken.
 *
 * Tauri IPC is async-only, so values the contract reads synchronously are
 * baked into `__T3_TAURI_INIT__` by the Rust side before this script runs.
 */

interface TauriInit {
  readonly branding: DesktopAppBranding;
  readonly platform: string;
  readonly locale: string | null;
  readonly appVersion: string;
  readonly hostArch: DesktopUpdateState["hostArch"];
  readonly localEnvironmentEnabled: boolean;
  readonly bootstraps: DesktopEnvironmentBootstrap[];
}

declare global {
  interface Window {
    __T3_TAURI_INIT__: TauriInit;
    __TAURI_INTERNALS__: {
      invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
    /** Called by the Rust shell through `WebviewWindow::eval` to push events. */
    __t3TauriEmit?: (event: string, payload: unknown) => void;
  }
}

const init = window.__T3_TAURI_INIT__;

function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return window.__TAURI_INTERNALS__.invoke(command, args) as Promise<T>;
}

const listeners = new Map<string, Set<(payload: unknown) => void>>();

window.__t3TauriEmit = (event, payload) => {
  for (const listener of listeners.get(event) ?? []) listener(payload);
};

function subscribe<T>(event: string, listener: (payload: T) => void): () => void {
  const set = listeners.get(event) ?? new Set();
  listeners.set(event, set);
  const wrapped = (payload: unknown) => listener(payload as T);
  set.add(wrapped);
  return () => set.delete(wrapped);
}

function unsupported(feature: string): Promise<never> {
  return Promise.reject(new Error(`${feature} is not available in the Tauri desktop build yet.`));
}

// A failed host call rejects with the helper's `{message, tag}` (see
// src-tauri/src/host.rs); anything else is Tauri's own string.
function toHostError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    const hostError = new Error(error.message);
    if ("tag" in error && typeof error.tag === "string") hostError.name = error.tag;
    return hostError;
  }
  return new Error(String(error));
}

/** Runs a method in the Node desktop host helper (`host/main.ts`). */
function hostCall<T>(method: string, params: unknown = null): Promise<T> {
  return invoke<T>("host_call", { method, params }).catch((error: unknown) => {
    throw toHostError(error);
  });
}

// The bootstrap token rotates every 12h window and a token is accepted for one
// to two windows. A long-lived page would otherwise hold an expired one, so
// keep the synchronously-read copy fresh.
let bootstraps = init.bootstraps;
const refreshBootstrapToken = async () => {
  const token = await invoke<string>("current_bootstrap_token");
  bootstraps = bootstraps.map((entry) =>
    entry.httpBaseUrl === null ? entry : { ...entry, bootstrapToken: token },
  );
};
setInterval(() => void refreshBootstrapToken().catch(() => undefined), 30 * 60 * 1000);

// Mirrors DesktopLocalEnvironmentAuth in the Electron shell: exchange the
// bootstrap token for a bearer session, retrying while the backend starts.
const BEARER_RETRY_TIMEOUT_MS = 15_000;
const BEARER_RETRY_INTERVAL_MS = 500;
// A request that reaches the server while it is still starting can go
// unanswered, so each attempt gets its own bound inside the overall deadline.
const BEARER_ATTEMPT_TIMEOUT_MS = 3_000;
const TRANSIENT_STATUS_CODES = new Set([502, 503, 504]);
let bearerToken: Promise<string> | undefined;

async function exchangeBearerToken(): Promise<string> {
  const primary = bootstraps.find((entry) => entry.id === "primary");
  if (!primary?.httpBaseUrl) throw new Error("Local backend is not configured.");
  const deadline = Date.now() + BEARER_RETRY_TIMEOUT_MS;
  for (;;) {
    const credential = await invoke<string>("current_bootstrap_token");
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "T3 Code Desktop",
      client_device_type: "desktop",
    });
    let transient: unknown;
    try {
      const remaining = Math.max(deadline - Date.now(), 1);
      const response = await fetch(new URL("/oauth/token", primary.httpBaseUrl), {
        method: "POST",
        body,
        signal: AbortSignal.timeout(Math.min(BEARER_ATTEMPT_TIMEOUT_MS, remaining)),
      });
      if (response.ok) {
        const result = (await response.json()) as { access_token: string };
        return result.access_token;
      }
      if (!TRANSIENT_STATUS_CODES.has(response.status)) {
        throw new Error(`Local bearer session request failed with status ${response.status}.`);
      }
      transient = new Error(`Local backend responded ${response.status}.`);
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      if (!(error instanceof TypeError) && !timedOut) throw error;
      transient = error;
    }
    if (Date.now() >= deadline) throw transient;
    await new Promise((resolve) => setTimeout(resolve, BEARER_RETRY_INTERVAL_MS));
  }
}

// Rust owns the exposure settings and the backend's bind host; the helper
// turns them into the LAN address and the advertised endpoints
// (host/exposure.ts). A write restarts the backend child (not the app, as
// Electron does), and the connection supervisor reconnects.
interface ServerExposureSettings {
  readonly mode: DesktopServerExposureMode;
  readonly port: number;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
}

function exposureInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args).catch((error: unknown) => {
    throw toHostError(error);
  });
}

async function readServerExposureState(): Promise<DesktopServerExposureState> {
  const settings = await invoke<ServerExposureSettings>("get_server_exposure_settings");
  // Local-only has nothing to resolve, so the helper is not started for it.
  const resolved =
    settings.mode === "network-accessible"
      ? await hostCall<{ endpointUrl: string | null; advertisedHost: string | null }>(
          "resolveServerExposure",
          settings,
        )
      : { endpointUrl: null, advertisedHost: null };
  return {
    mode: settings.mode,
    endpointUrl: resolved.endpointUrl,
    advertisedHost: resolved.advertisedHost,
    tailscaleServeEnabled: settings.tailscaleServeEnabled,
    tailscaleServePort: settings.tailscaleServePort,
  };
}

const wslState: DesktopWslState = {
  enabled: false,
  distro: null,
  available: false,
  wslOnly: false,
  distros: [],
  preflightError: null,
};

const updateState: DesktopUpdateState = {
  enabled: false,
  status: "disabled",
  channel: "latest",
  currentVersion: init.appVersion,
  hostArch: init.hostArch,
  appArch: init.hostArch,
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: "Updates are not available in the Tauri desktop build yet.",
  errorContext: null,
  canRetry: false,
};

function stripWebOnlyFields<T extends string>(
  items: readonly ContextMenuItem<T>[],
): ContextMenuItem<T>[] {
  return items
    .filter((item) => !item.header)
    .map(({ header: _header, icon: _icon, children, ...item }) =>
      children === undefined ? item : { ...item, children: stripWebOnlyFields(children) },
    );
}

let localEnvironmentEnabled = init.localEnvironmentEnabled;
let fullscreen = false;
subscribe<boolean>("fullscreen", (next) => {
  fullscreen = next;
});
// Rust pushes the state on every page load and whenever it changes.
let maximized = false;
subscribe<boolean>("maximized", (next) => {
  maximized = next;
});
// Windows has no native frame (see lib.rs), so the web app draws the caption
// buttons. macOS keeps its traffic lights and Linux its native decorations.
const windowControls: NonNullable<DesktopBridge["windowControls"]> = {
  minimize: () => invoke("minimize_window"),
  toggleMaximize: () => invoke("toggle_maximize_window"),
  close: () => invoke("close_window"),
  getMaximizedState: () => maximized,
  onMaximizedStateChange: (listener) => subscribe("maximized", listener),
};

if (init.platform === "darwin") {
  // Mirrors apps/desktop/src/preload.ts: the native window buttons do not
  // scale with page zoom, so their reserved space is kept in native points.
  // Rust pushes the factor after every zoom change and page load.
  let zoomFactor = 1;
  const syncWindowControlInset = () => {
    document.documentElement.style.setProperty(
      "--desktop-window-controls-inset",
      `${90 / zoomFactor}px`,
    );
  };
  subscribe<number>("zoom", (factor) => {
    zoomFactor = factor;
    syncWindowControlInset();
  });
  window.addEventListener("DOMContentLoaded", syncWindowControlInset, { once: true });

  // WKWebView ignores `-webkit-app-region`, which is how the web app marks
  // its title bar (`.drag-region`, with `no-drag` on controls and their
  // containers), so a press inside a drag region starts the native drag here.
  // WebView2 honors the CSS itself.
  const NO_DRAG_SELECTOR =
    'a, button, input, select, textarea, [contenteditable], [tabindex], [role="button"], [class*="app-region:no-drag"]';
  document.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    const region = event.target.closest(".drag-region");
    if (region === null) return;
    const noDrag = event.target.closest(NO_DRAG_SELECTOR);
    if (noDrag !== null && region.contains(noDrag)) return;
    event.preventDefault();
    void invoke("drag_window", { maximize: event.detail === 2 }).catch(() => undefined);
  });
}

const bridge = {
  getAppBranding: () => init.branding,
  getClientPlatform: () => init.platform,
  getSystemLocale: () => init.locale,
  getLocalEnvironmentBootstraps: () => bootstraps,
  getLocalEnvironmentEnabled: () => localEnvironmentEnabled,
  setLocalEnvironmentEnabled: async (enabled) => {
    await invoke("set_local_environment_enabled", { enabled });
    localEnvironmentEnabled = enabled;
  },
  getLocalEnvironmentBearerToken: () => {
    bearerToken ??= exchangeBearerToken().catch((error: unknown) => {
      bearerToken = undefined;
      throw error;
    });
    return bearerToken;
  },
  getClientSettings: () => invoke("get_client_settings"),
  setClientSettings: (settings) => invoke("set_client_settings", { settings }),

  setNotificationBadge: (badge) => invoke("set_notification_badge", { count: badge.count }),
  pickFolder: async (options) =>
    invoke("pick_folder", { initialPath: options?.initialPath ?? null }),
  pickProjectFavicon: (initialPath) =>
    invoke("pick_project_favicon", { initialPath: initialPath ?? null }),
  pickThemeFiles: () => invoke<PickedThemeFile[] | null>("pick_theme_files"),
  setTheme: (theme) => invoke("set_theme", { theme }),
  showContextMenu: (items, position) =>
    invoke("show_context_menu", {
      items: stripWebOnlyFields(items),
      position: position ?? null,
    }),
  openExternal: (url) => invoke("open_external", { url }),

  onMenuAction: (listener) => subscribe("menu-action", listener),
  getWindowFullscreenState: () => fullscreen,
  onWindowFullscreenStateChange: (listener) => subscribe("fullscreen", listener),
  ...(init.platform === "win32" ? { windowControls } : {}),

  discoverSshHosts: () => hostCall("discoverSshHosts"),
  resolveSshHost: (alias) => hostCall("resolveSshHost", alias),

  // Not ported yet. Reads return an inert state so settings pages render;
  // writes reject so the UI surfaces the gap instead of pretending.
  ensureSshEnvironment: () => unsupported("SSH"),
  disconnectSshEnvironment: () => unsupported("SSH"),
  fetchSshEnvironmentDescriptor: () => unsupported("SSH"),
  bootstrapSshBearerSession: () => unsupported("SSH"),
  fetchSshSessionState: () => unsupported("SSH"),
  issueSshWebSocketTicket: () => unsupported("SSH"),
  onSshPasswordPrompt: () => () => undefined,
  resolveSshPasswordPrompt: () => unsupported("SSH"),
  getServerExposureState: readServerExposureState,
  setServerExposureMode: async (mode) => {
    await exposureInvoke("set_server_exposure_mode", { mode });
    return readServerExposureState();
  },
  setTailscaleServeEnabled: async ({ enabled, port }) => {
    await exposureInvoke("set_tailscale_serve_enabled", { enabled, port: port ?? null });
    return readServerExposureState();
  },
  getAdvertisedEndpoints: async () => {
    const settings = await invoke<ServerExposureSettings>("get_server_exposure_settings");
    return hostCall("resolveAdvertisedEndpoints", settings);
  },
  getWslState: async () => wslState,
  setWslBackendEnabled: () => unsupported("WSL"),
  setWslDistro: () => unsupported("WSL"),
  setWslOnly: () => unsupported("WSL"),
  getUpdateState: async () => updateState,
  setUpdateChannel: async () => updateState,
  checkForUpdate: async () => ({ checked: false, state: updateState }),
  downloadUpdate: async () => ({ accepted: false, completed: false, state: updateState }),
  installUpdate: async () => ({ accepted: false, completed: false, state: updateState }),
  onUpdateState: () => () => undefined,
} satisfies DesktopBridge;

Object.defineProperty(window, "desktopBridge", {
  value: Object.freeze(bridge),
  configurable: false,
  writable: false,
});
