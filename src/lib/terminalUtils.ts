/**
 * Pure utility functions extracted from TerminalPane / App for unit testing.
 *
 * Keep these functions free of DOM/Tauri/React dependencies where possible so
 * they can be tested headlessly. The integration glue stays in the components.
 */

/**
 * Characters that MUST render as a single column (width 1), even though a CJK
 * font might otherwise draw them double-width. These are the box-drawing and
 * symbol glyphs that TUIs (Claude Code, codex) use to draw borders and status
 * lines: if they go double-width the borders break apart / look dotted and the
 * whole frame is misaligned. Checked BEFORE isAmbiguousWide.
 */
export function isForceNarrow(cp: number): boolean {
  return (
    (cp >= 0x2500 && cp <= 0x257f) || // Box Drawing: ─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼
    (cp >= 0x2580 && cp <= 0x259f) || // Block Elements: ▀ █ ░ ▒ ▓
    (cp >= 0x25a0 && cp <= 0x25ff) || // Geometric Shapes: ■ ● ▲ ◯
    (cp >= 0x2190 && cp <= 0x21ff) || // Arrows: ← → ↑ ↓
    (cp >= 0x2200 && cp <= 0x22ff) || // Math operators: ∀ ∃ ∈
    (cp >= 0x2300 && cp <= 0x23ff) || // Misc technical: ⌘ ⏵ ⎵
    (cp >= 0x2600 && cp <= 0x26ff) || // Misc Symbols: ★ ☆ ☀
    (cp >= 0x2700 && cp <= 0x27bf) || // Dingbats: ✓ ✗ ✚
    (cp >= 0x2070 && cp <= 0x209f) || // Super/Subscripts
    (cp >= 0x2150 && cp <= 0x218f)    // Number Forms: ⅓ ⅔
  );
}

/**
 * Returns true if the Unicode codepoint should be rendered as 2 columns wide so
 * it doesn't visually overlap the next character in a CJK font. Kept narrow in
 * the default Unicode "ambiguous = 1" handling, these specifically need width 2.
 * Limited to enclosed alphanumerics (①②③ ⑩ ⓪) — the symbols/box-drawing that
 * used to be here are now forced narrow via isForceNarrow().
 */
export function isAmbiguousWide(cp: number): boolean {
  return cp >= 0x2460 && cp <= 0x24ff; // Enclosed Alphanumerics: ①②③ ⑩ ⓪ Ⓐ
}

/**
 * East Asian "Wide"/"Fullwidth" codepoints that occupy 2 terminal columns —
 * kana, kanji, Hangul, fullwidth forms, etc. This is a self-contained safety
 * net so the CJK width provider stays correct even if it can't read xterm's
 * built-in Unicode 11 widths: without it, a failed lookup would make EVERY
 * kanji collapse to 1 column and the whole screen would overlap.
 */
export function isWideCJK(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x2eff) || // CJK Radicals Supplement
    (cp >= 0x2f00 && cp <= 0x2fdf) || // Kangxi Radicals
    (cp >= 0x3000 && cp <= 0x303f) || // CJK Symbols & Punctuation: 　 、 。 「 」
    (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
    (cp >= 0x3100 && cp <= 0x312f) || // Bopomofo
    (cp >= 0x3130 && cp <= 0x318f) || // Hangul Compatibility Jamo
    (cp >= 0x3190 && cp <= 0x31ff) || // Kanbun, Bopomofo ext, Katakana ext
    (cp >= 0x3200 && cp <= 0x33ff) || // Enclosed CJK, CJK Compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Unified Ideographs Extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs (common kanji)
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi Syllables
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms (！＂…ｚ)
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs (￥ ￦ etc.)
    (cp >= 0x1f300 && cp <= 0x1faff) || // Emoji & pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Unified Ideographs Extensions B–
  );
}

/**
 * Decision the keyboard handler should make for a given keydown event.
 *  - "copy"         : selected text → clipboard, prevent default
 *  - "paste"        : clipboard → terminal, prevent default
 *  - "pass"         : let xterm.js handle this event normally
 */
export type KeyDecision = "copy" | "paste" | "pass";

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

  // NOTE: We previously special-cased Mac Shift+letter ("shift-direct") to
  // avoid a perceived first-character delay (#4). That hack double-emitted the
  // character on Mac WebKit because xterm.js's onData fires BEFORE the custom
  // key handler (xterm.js #5374), so preventDefault could not stop the first,
  // already-sent copy. Letting Shift+letter pass through to xterm.js handles
  // uppercase correctly and without doubling, so the special case is removed.

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
