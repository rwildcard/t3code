# Tauri desktop shell

A Tauri v2 shell for the web client, meant to eventually replace `apps/desktop`
(Electron). It runs next to the Electron app until it covers the same bridge.

```sh
vp run dev:desktop-tauri            # from the repo root
vp run dev:desktop-tauri --home-dir <dir>   # isolated state, see AGENTS.md
```

Requires a Rust toolchain. The first run compiles the shell, which takes a few minutes.

## How it fits together

- `src-tauri/src/backend.rs` starts `apps/server` with Node and supervises it, the
  same backend the Electron shell runs. The bootstrap envelope goes over stdin
  (`--bootstrap-fd 0`). The bootstrap token rotates from a shared secret, as
  `@t3tools/shared/desktopBootstrapToken` describes. On Windows the backend runs in a
  job object, so its process tree dies with the app.
- `src/bridge.ts` is bundled to `dist/bridge.iife.js`, embedded in the binary, and
  injected as `window.desktopBridge` before page scripts run. The web app treats
  the bridge's presence as "desktop". Tauri IPC is async, so the values the
  `DesktopBridge` contract reads synchronously (branding, platform, locale,
  environment bootstraps) are baked into the script by Rust.
- Settings are read from and written to the same files as the Electron shell
  (`client-settings.json`, `desktop-settings.json` under the T3 state dir).
- `host/` is the desktop host helper: a Node process that runs the
  Electron-free desktop TypeScript (`packages/ssh` and `packages/tailscale`
  today; WSL later) so none of it is rewritten in Rust or shipped in `npx t3`. Rust
  (`src-tauri/src/host.rs`) spawns it on the first bridge call that needs it,
  inside the same Windows job object scheme as the backend, and starts a new
  one on the next call after it exits. Newline-delimited JSON over stdio
  (`host/protocol.ts`), with stderr going to `logs/desktop-tauri-host.log`.
  `bridge.ts` reaches it through the `host_call` command; helper events arrive
  as `host:<event>` through the bridge's `subscribe`.

## Bridge coverage

Ported: branding, platform, locale, local environment bootstrap and bearer token,
local environment on/off, client settings, folder/favicon/theme pickers, theme
(native frame and window background), native context menus, open external,
notification badge (macOS/Linux), fullscreen state, the application menu
(`onMenuAction`, see `src-tauri/src/menu.rs`; the bar is hidden on Windows and
Linux as in Electron, accelerators still work), and the macOS title bar
(overlay style, traffic lights in the top bar, drag regions driven from the
bridge), and the Windows title bar (frameless window; WebView2 has no
window-controls overlay, so the bridge exposes `windowControls` and the web app
draws the caption buttons itself, see `WindowCaptionControls.tsx`; drag and
double-click-to-maximize are WebView2's own `app-region` support). Linux keeps
native window decorations. Not covered on Windows: the Windows 11 snap-layouts
flyout on the maximize button, which needs a native `HTMAXBUTTON` hit test that
neither WebView2's non-client region support nor tao offers.

Network exposure and Tailscale Serve: Rust keeps `serverExposureMode`,
`tailscaleServeEnabled`, and `tailscaleServePort` in `desktop-settings.json`
and feeds the bind host and Serve flags into the backend bootstrap; the
helper (`host/exposure.ts`) resolves the LAN address and the advertised
endpoints from the same pure helpers the Electron shell uses
(`@t3tools/shared/desktopServerExposure`, `@t3tools/tailscale`). A change
restarts only the backend child, with the same port and bootstrap secret,
instead of relaunching the app as Electron does; the web app's connection
supervisor reconnects. Because the Windows backend is ended through its job
object, the server never runs its own `tailscale serve off`, so the helper
runs it when Serve is disabled or moved to another port. A persisted
network-accessible mode binds 0.0.0.0 even while no LAN address is up
(Electron falls back to loopback until the next relaunch).

Not ported yet. These return inert state or reject, and the UI hides
optional members: preview browser, Snap Shot capture, WSL
backend, auto-updates, the `t3` CLI shim
and app activation, Clerk passkeys, connection catalog (keyring), system
permission panes, dropped-file paths (`getPathForFile`), the hold/double-press
quit confirmation (`onQuitShortcut`, Quit is immediate), the Paste as Text
menu item (`pasteAsText`; the keyboard chord is the webview's own), and the
macOS traffic-light re-centering on zoom.

SSH runs in the desktop host helper (`host/ssh.ts`): host discovery and
alias resolution as before, plus `SshEnvironmentManager` from `packages/ssh`,
which owns the `ssh` tunnel processes for the helper's lifetime. The remote
runs the CLI release archive of the app's version (Rust passes it as
`T3CODE_TAURI_APP_VERSION`), or in dev a checkout named by
`T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH`, the same rule as the Electron
shell. In-app password prompts are `sshPasswordPrompt` helper events: Rust
brings the window forward and forwards them, and the page answers through
`resolveSshPasswordPrompt`; a page reload abandons pending prompts so the
connect attempt fails instead of waiting out the three-minute timeout. The
remote API methods (descriptor, bearer bootstrap, session state, WebSocket
ticket) proxy to the loopback tunnel from the helper, as Electron's main
process does, so the page never fetches the tunnel origin directly. SSH host
calls pass their own deadline to `host_call`; everything else keeps the 30s
default. On exit the shell closes the helper's stdin and waits up to 5s so
the helper can end its tunnels and stop the remote servers it launched,
which Electron's layer teardown does on quit; after that the job object
ends whatever is left.

## Packaging

```sh
vp run dist:desktop-tauri:win       # Windows x64 NSIS installer, written to release/
```

`scripts/build-desktop-tauri-artifact.ts` builds the server and web client,
stages a release tree under `stage/<platform>-<arch>/` (a stock `node` copied
from the build host, the server bundle, the web client, the resource monitor,
a hoisted install of the server's runtime-external packages, and the desktop
host bundle `host/main.mjs`), checks that the staged server and host start
without the repo's `node_modules`, and runs `tauri build` with a `--config`
override that adds the stage as resources and the Node sidecar.
`tauri.conf.json` itself carries no stage paths, so `tauri dev` keeps working.

The release build runs `node` from next to the executable with
`<resources>/server/bin.mjs` and `<resources>/host/main.mjs`; on Windows the
resource dir is the executable's directory. `T3CODE_TAURI_NODE`,
`T3CODE_TAURI_SERVER_ENTRY`, and `T3CODE_TAURI_HOST_ENTRY` override them. In
dev both run from source with the `node` on PATH.
Only Windows is wired up; other platforms need a row in `TAURI_TARGETS` plus
signing. Not covered: code signing, updates, and the `t3` CLI shim.
