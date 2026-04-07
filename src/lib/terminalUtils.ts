/**
 * Pure utility functions extracted from TerminalPane / App for unit testing.
 *
 * Keep these functions free of DOM/Tauri/React dependencies where possible so
 * they can be tested headlessly. The integration glue stays in the components.
 */

/**
 * Returns true if the Unicode codepoint is "East Asian Ambiguous" width and
 * should be rendered as 2 columns wide in CJK fonts. This fixes characters
 * like ①②③, ★, ◯, box drawing, etc. visually overlapping in xterm.js.
 */
export function isAmbiguousWide(cp: number): boolean {
  return (
    (cp >= 0x2460 && cp <= 0x24ff) || // Enclosed Alphanumerics: ①②③ ⓿ Ⓐ
    (cp >= 0x2500 && cp <= 0x257f) || // Box Drawing
    (cp >= 0x2580 && cp <= 0x259f) || // Block Elements
    (cp >= 0x25a0 && cp <= 0x25ff) || // Geometric Shapes: ◯ ■ ▲
    (cp >= 0x2600 && cp <= 0x26ff) || // Misc Symbols: ★ ☆ ☀
    (cp >= 0x2700 && cp <= 0x27bf) || // Dingbats: ✓ ✗ ✚
    (cp >= 0x2070 && cp <= 0x209f) || // Super/Subscripts
    (cp >= 0x2150 && cp <= 0x218f) || // Number Forms: ⅓ ⅔
    (cp >= 0x2190 && cp <= 0x21ff) || // Arrows: ← → ↑ ↓
    (cp >= 0x2200 && cp <= 0x22ff) || // Math operators: ∀ ∃ ∈
    (cp >= 0x2300 && cp <= 0x23ff) || // Misc technical
    (cp >= 0x2e80 && cp <= 0x2eff) || // CJK Radicals Supplement
    (cp >= 0x3000 && cp <= 0x303f) || // CJK Symbols and Punctuation
    cp === 0x00a7 ||
    cp === 0x00a8 || // § ¨
    cp === 0x00b0 ||
    cp === 0x00b1 || // ° ±
    cp === 0x00b4 ||
    cp === 0x00b6 || // ´ ¶
    cp === 0x00d7 ||
    cp === 0x00f7 // × ÷
  );
}

/**
 * Decision the keyboard handler should make for a given keydown event.
 *  - "copy"         : selected text → clipboard, prevent default
 *  - "paste"        : clipboard → terminal, prevent default
 *  - "shift-direct" : Mac WebKit shift+letter; write directly to bypass
 *                     the hidden textarea's dead-key composition delay.
 *  - "pass"         : let xterm.js handle this event normally
 */
export type KeyDecision = "copy" | "paste" | "shift-direct" | "pass";

export interface KeyEventLike {
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

export function decideKeyAction(
  e: KeyEventLike,
  isMac: boolean,
  hasSelection: boolean,
): KeyDecision {
  if (e.type !== "keydown") return "pass";

  // Mac WebKit Shift+letter early-send to avoid first-character delay.
  // Skip during IME composition so Japanese input still works.
  if (
    isMac &&
    !e.isComposing &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    e.shiftKey &&
    e.key.length === 1
  ) {
    return "shift-direct";
  }

  const key = e.key.toLowerCase();

  // Copy:
  //   Mac:     Cmd+C
  //   Win/Lin: Ctrl+Shift+C  OR  Ctrl+C (when selected)
  const isCopy = isMac
    ? e.metaKey && key === "c"
    : e.ctrlKey && (e.shiftKey || hasSelection) && key === "c";
  if (isCopy) return "copy";

  // Paste:
  //   Mac:     Cmd+V
  //   Win/Lin: Ctrl+V (or Ctrl+Shift+V)
  const isPaste = isMac
    ? e.metaKey && key === "v"
    : e.ctrlKey && key === "v";
  if (isPaste) return "paste";

  return "pass";
}

/**
 * Right-click decision: copy if there is a selection, otherwise paste.
 * Matches Windows Terminal smart-context-menu behavior.
 */
export type RightClickDecision = "copy" | "paste";

export function decideRightClick(hasSelection: boolean): RightClickDecision {
  return hasSelection ? "copy" : "paste";
}

/**
 * Find the session id for a drop position. Tauri provides physical pixel
 * coordinates; divide by devicePixelRatio to get logical pixels for
 * `document.elementFromPoint()`. The element nearest the point should be
 * (or be inside) a node with `data-session-id` attribute.
 *
 * Returns the session id of the pane the drop landed on, or `fallback` if
 * the position doesn't resolve to any pane (e.g. dropped on the sidebar).
 */
export function findDropTargetSession(
  pos: { x: number; y: number } | undefined,
  scale: number,
  doc: Document,
  fallback: string | null,
): string | null {
  if (!pos) return fallback;
  const cx = pos.x / scale;
  const cy = pos.y / scale;
  const el = doc.elementFromPoint(cx, cy);
  const pane = el?.closest("[data-session-id]") as HTMLElement | null;
  if (pane) {
    return pane.getAttribute("data-session-id") || fallback;
  }
  return fallback;
}

/**
 * Construct the shell command fragment for a list of file paths.
 * Each path is wrapped in double quotes, with backslashes and existing
 * double quotes escaped. A trailing space is added so it can be appended
 * to whatever the user is currently typing.
 */
export function pathsToShellArgs(paths: string[]): string {
  return (
    paths
      .map((p) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
      .join(" ") + " "
  );
}
