import { useSyncExternalStore } from "react";

import { cn } from "../../lib/utils";

const subscribeToNothing = () => () => {};

// Chromium's Windows caption glyphs: 10px, 1px strokes, in the symbol color.
const GLYPH_CLASS = "size-2.5 [shape-rendering:crispEdges]";
const MinimizeGlyph = () => (
  <svg viewBox="0 0 10 10" aria-hidden className={GLYPH_CLASS}>
    <path d="M0 5h10" stroke="currentColor" />
  </svg>
);
const MaximizeGlyph = () => (
  <svg viewBox="0 0 10 10" aria-hidden className={GLYPH_CLASS}>
    <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
  </svg>
);
const RestoreGlyph = () => (
  <svg viewBox="0 0 10 10" aria-hidden className={GLYPH_CLASS}>
    <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
    <path d="M2.5 2.5v-2h7v7h-2" fill="none" stroke="currentColor" />
  </svg>
);
const CloseGlyph = () => (
  <svg viewBox="0 0 10 10" aria-hidden className="size-2.5">
    <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" />
  </svg>
);

const BUTTON_CLASS =
  "pointer-events-auto flex h-full w-(--window-caption-button-width) items-center justify-center text-foreground outline-none [-webkit-app-region:no-drag]";

/**
 * The minimize, maximize/restore and close buttons for a desktop shell that
 * draws no native ones (`desktopBridge.windowControls`, the Tauri shell on
 * Windows). Fixed at the top right where Chromium's title-bar overlay puts
 * them in the Electron shell; the title bar reserves the space through the
 * `.page-window-controls` variables in index.css. Renders nothing elsewhere.
 */
export function WindowCaptionControls() {
  const controls = window.desktopBridge?.windowControls;
  const maximized = useSyncExternalStore(
    controls?.onMaximizedStateChange ?? subscribeToNothing,
    () => controls?.getMaximizedState() ?? false,
  );

  if (!controls) return null;
  return (
    <div
      className="pointer-events-none fixed top-0 right-0 z-[150] flex h-(--workspace-topbar-height) [-webkit-app-region:no-drag]"
      data-window-caption-controls
    >
      <button
        type="button"
        aria-label="Minimize"
        tabIndex={-1}
        className={cn(BUTTON_CLASS, "hover:bg-foreground/10 active:bg-foreground/5")}
        onClick={() => void controls.minimize()}
      >
        <MinimizeGlyph />
      </button>
      <button
        type="button"
        aria-label={maximized ? "Restore" : "Maximize"}
        tabIndex={-1}
        className={cn(BUTTON_CLASS, "hover:bg-foreground/10 active:bg-foreground/5")}
        onClick={() => void controls.toggleMaximize()}
      >
        {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
      </button>
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        className={cn(
          BUTTON_CLASS,
          "hover:bg-window-caption-close hover:text-white active:bg-window-caption-close/90 active:text-white",
        )}
        onClick={() => void controls.close()}
      >
        <CloseGlyph />
      </button>
    </div>
  );
}
