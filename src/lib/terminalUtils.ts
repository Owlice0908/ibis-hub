/**
 * Pure utility functions extracted from TerminalPane / App for unit testing.
 *
 * Keep these functions free of DOM/Tauri/React dependencies where possible so
 * they can be tested headlessly. The integration glue stays in the components.
 */

/**
 * Returns true if the Unicode codepoint is "East Asian Ambiguous" width and
 * should be rendered as 2 columns wide in CJK fonts.
 *
 * IMPORTANT: This list is intentionally narrow. Many code points that are
 * technically "East Asian Ambiguous" (box drawing, block elements,
 * geometric shapes, arrows, math operators, etc.) are heavily used by
 * TUI applications (Claude Code, vim, htop, fzf...) which expect them
 * to render as 1 column. Marking those as wide breaks TUI border
 * rendering — the borders look "dotted" because every other cell
 * becomes empty padding.
 *
 * Only ranges that TUIs essentially never use AND that visually overlap
 * with neighboring characters when treated as 1-col are included here:
 *  - Enclosed Alphanumerics (①②③⓿Ⓐ) — the original complaint
 *  - CJK Symbols and Punctuation (the wide bracket forms)
 *  - CJK Radicals Supplement
 */
export function isAmbiguousWide(cp: number): boolean {
  return (
    (cp >= 0x2460 && cp <= 0x24ff) || // Enclosed Alphanumerics: ①②③ ⓿ Ⓐ
    (cp >= 0x2e80 && cp <= 0x2eff) || // CJK Radicals Supplement
    (cp >= 0x3000 && cp <= 0x303f) // CJK Symbols and Punctuation
  );
}

/**
 * Decision the keyboard handler should make for a given keydown event.
 *  - "copy"         : selected text → clipboard, prevent default
 *  - "paste"        : clipboard → terminal, prevent default
 *  - "shift-direct" : Mac WebKit Shift+letter; write directly to bypass
 *                     the WebKit DOM event ordering bug where customKeyEvent
 *                     fires after onData (xterm.js issue #5374). Restricted
 *                     to A-Z only to avoid breaking Shift+Space, Shift+symbols,
 *                     dead keys, and IME interactions.
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
  // Restricted to plain ASCII letters A-Z only:
  // - Shift+Space, Shift+!, Shift+digit/symbol must NOT be hijacked because
  //   xterm.js maps them to specific escape sequences.
  // - Dead keys (e.key === "Dead") and arrow/function keys (length > 1)
  //   are also excluded by the /^[A-Za-z]$/ test.
  // - IME composition is excluded so Japanese input still works.
  if (
    isMac &&
    !e.isComposing &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    e.shiftKey &&
    /^[A-Za-z]$/.test(e.key)
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
 * Find the session id for a drop position.
 *
 * Tauri's `onDragDropEvent` payload position has unit semantics that vary
 * by platform due to a known wry bug (tauri#10744):
 *  - macOS: wry returns LOGICAL points (no scale_factor multiplication),
 *    even though the JS API wraps them in `PhysicalPosition`. So we must
 *    NOT divide by devicePixelRatio on Mac, otherwise on Retina (scale=2)
 *    the cursor maps to the upper-left 1/4 of the window.
 *  - Windows/Linux: payload is true physical pixels and must be divided
 *    by devicePixelRatio for `elementFromPoint` (which uses CSS pixels).
 *
 * Returns the session id of the pane the drop landed on, or `fallback`
 * if the position doesn't resolve to any pane.
 */
export function findDropTargetSession(
  pos: { x: number; y: number } | undefined,
  scale: number,
  doc: Document,
  fallback: string | null,
  isMac: boolean = false,
): string | null {
  if (!pos) return fallback;
  // On Mac, wry already returns logical points; don't divide.
  // On Win/Linux, divide physical pixels by scale to get CSS pixels.
  const cx = isMac ? pos.x : pos.x / scale;
  const cy = isMac ? pos.y : pos.y / scale;
  const el = doc.elementFromPoint(cx, cy);
  const pane = el?.closest("[data-session-id]") as HTMLElement | null;
  if (pane) {
    return pane.getAttribute("data-session-id") || fallback;
  }
  return fallback;
}

/**
 * Convert a Tauri D&D event position to logical CSS pixels for the current
 * platform. Use this when you need to do hit-testing against
 * `getBoundingClientRect()` or pass to `elementFromPoint()`.
 */
export function dndPositionToLogical(
  pos: { x: number; y: number },
  scale: number,
  isMac: boolean,
): { x: number; y: number } {
  if (isMac) return { x: pos.x, y: pos.y };
  return { x: pos.x / scale, y: pos.y / scale };
}

/**
 * Construct a shell-safe command fragment from a list of file paths.
 *
 * Wraps each path in DOUBLE quotes and escapes every character that has
 * special meaning inside POSIX double quotes:
 *   \   backslash (escape char itself)
 *   "   quote close
 *   $   variable expansion
 *   `   command substitution (legacy)
 *   !   history expansion (interactive bash only, but still escape)
 *
 * Newlines are stripped/replaced with a space because a newline inside a
 * pasted argument would be interpreted as a command separator.
 *
 * IMPORTANT: This is a security boundary. A filename like
 * `$(rm -rf ~).txt` dropped into the terminal must NOT execute the
 * subshell. Tested in tests/unit/terminalUtils.test.ts.
 */
export function pathsToShellArgs(paths: string[]): string {
  if (paths.length === 0) return "";
  return (
    paths
      .map((p) => {
        // Strip newlines (a newline inside a quoted arg would split commands)
        const noNewlines = p.replace(/[\r\n]+/g, " ");
        // Escape every char with special meaning inside POSIX double quotes
        const escaped = noNewlines.replace(/[\\"$`!]/g, (m) => "\\" + m);
        return `"${escaped}"`;
      })
      .join(" ") + " "
  );
}
