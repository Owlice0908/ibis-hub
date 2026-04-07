import { describe, it, expect, beforeEach } from "vitest";
import {
  isAmbiguousWide,
  decideKeyAction,
  decideRightClick,
  findDropTargetSession,
  pathsToShellArgs,
  type KeyEventLike,
} from "../../src/lib/terminalUtils";

// ============================================================================
// CJK ambiguous-width fix (#10 — ①②③ overlap repair)
// ============================================================================
describe("isAmbiguousWide — CJK ambiguous-width detection", () => {
  it("treats circled numbers ①②③⑩⑳ as wide", () => {
    expect(isAmbiguousWide(0x2460)).toBe(true); // ①
    expect(isAmbiguousWide(0x2461)).toBe(true); // ②
    expect(isAmbiguousWide(0x2462)).toBe(true); // ③
    expect(isAmbiguousWide(0x2469)).toBe(true); // ⑩
    expect(isAmbiguousWide(0x2473)).toBe(true); // ⑳
  });

  it("treats geometric shapes ◯ ■ ▲ as wide", () => {
    expect(isAmbiguousWide(0x25cb)).toBe(true); // ◯
    expect(isAmbiguousWide(0x25a0)).toBe(true); // ■
    expect(isAmbiguousWide(0x25b2)).toBe(true); // ▲
  });

  it("treats misc symbols ★ ☆ as wide", () => {
    expect(isAmbiguousWide(0x2605)).toBe(true); // ★
    expect(isAmbiguousWide(0x2606)).toBe(true); // ☆
  });

  it("treats arrows ← → ↑ ↓ as wide", () => {
    expect(isAmbiguousWide(0x2190)).toBe(true); // ←
    expect(isAmbiguousWide(0x2191)).toBe(true); // ↑
    expect(isAmbiguousWide(0x2192)).toBe(true); // →
    expect(isAmbiguousWide(0x2193)).toBe(true); // ↓
  });

  it("treats box drawing as wide", () => {
    expect(isAmbiguousWide(0x2500)).toBe(true); // ─
    expect(isAmbiguousWide(0x2502)).toBe(true); // │
    expect(isAmbiguousWide(0x250c)).toBe(true); // ┌
  });

  it("treats specific Latin1 symbols ° ± × ÷ as wide", () => {
    expect(isAmbiguousWide(0x00b0)).toBe(true); // °
    expect(isAmbiguousWide(0x00b1)).toBe(true); // ±
    expect(isAmbiguousWide(0x00d7)).toBe(true); // ×
    expect(isAmbiguousWide(0x00f7)).toBe(true); // ÷
  });

  it("does NOT treat normal ASCII letters as wide", () => {
    expect(isAmbiguousWide(0x41)).toBe(false); // A
    expect(isAmbiguousWide(0x61)).toBe(false); // a
    expect(isAmbiguousWide(0x30)).toBe(false); // 0
    expect(isAmbiguousWide(0x20)).toBe(false); // space
  });

  it("does NOT treat regular Latin1 letters as wide", () => {
    expect(isAmbiguousWide(0x00e9)).toBe(false); // é
    expect(isAmbiguousWide(0x00fc)).toBe(false); // ü
  });
});

// ============================================================================
// Mac Shift+大文字 first-character delay fix (#4)
// ============================================================================
describe("decideKeyAction — Mac Shift+letter early send", () => {
  const baseEvent: KeyEventLike = {
    type: "keydown",
    key: "",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
  };

  it("returns 'shift-direct' for Mac Shift+A through Shift+Z (all uppercase letters)", () => {
    for (let c = 0x41; c <= 0x5a; c++) {
      const e = { ...baseEvent, key: String.fromCharCode(c), shiftKey: true };
      expect(decideKeyAction(e, true, false)).toBe("shift-direct");
    }
  });

  it("returns 'shift-direct' for Mac Shift + lowercase a-z (caps lock case)", () => {
    // shift+lowercase happens when caps lock affects key property differently
    for (let c = 0x61; c <= 0x7a; c++) {
      const e = { ...baseEvent, key: String.fromCharCode(c), shiftKey: true };
      expect(decideKeyAction(e, true, false)).toBe("shift-direct");
    }
  });

  it("does NOT return 'shift-direct' for Mac Shift+! (was a bug — symbols must pass through)", () => {
    const e = { ...baseEvent, key: "!", shiftKey: true };
    expect(decideKeyAction(e, true, false)).toBe("pass");
  });

  it("does NOT return 'shift-direct' for Mac Shift+digit symbols (@#$%^&*)", () => {
    for (const k of ["@", "#", "$", "%", "^", "&", "*", "(", ")"]) {
      const e = { ...baseEvent, key: k, shiftKey: true };
      expect(decideKeyAction(e, true, false)).toBe("pass");
    }
  });

  it("does NOT return 'shift-direct' for Mac Shift+Space (preserves xterm escape)", () => {
    const e = { ...baseEvent, key: " ", shiftKey: true };
    expect(decideKeyAction(e, true, false)).toBe("pass");
  });

  it("does NOT return 'shift-direct' on Win/Linux (only Mac has the bug)", () => {
    const e = { ...baseEvent, key: "A", shiftKey: true };
    expect(decideKeyAction(e, false, false)).toBe("pass");
  });

  it("does NOT return 'shift-direct' during IME composition (preserves Japanese input)", () => {
    const e = { ...baseEvent, key: "a", shiftKey: true, isComposing: true };
    expect(decideKeyAction(e, true, false)).toBe("pass");
  });

  it("does NOT return 'shift-direct' for shift + arrow keys", () => {
    const e = { ...baseEvent, key: "ArrowLeft", shiftKey: true };
    expect(decideKeyAction(e, true, false)).toBe("pass");
  });

  it("does NOT return 'shift-direct' for shift + Tab/Enter/Backspace", () => {
    for (const k of ["Tab", "Enter", "Backspace", "Delete", "Escape"]) {
      const e = { ...baseEvent, key: k, shiftKey: true };
      expect(decideKeyAction(e, true, false)).toBe("pass");
    }
  });

  it("does NOT return 'shift-direct' for Function keys", () => {
    for (let i = 1; i <= 12; i++) {
      const e = { ...baseEvent, key: `F${i}`, shiftKey: true };
      expect(decideKeyAction(e, true, false)).toBe("pass");
    }
  });

  it("does NOT return 'shift-direct' for Page Up/Down/Home/End/Insert", () => {
    for (const k of ["PageUp", "PageDown", "Home", "End", "Insert"]) {
      const e = { ...baseEvent, key: k, shiftKey: true };
      expect(decideKeyAction(e, true, false)).toBe("pass");
    }
  });

  it("does NOT return 'shift-direct' for dead keys", () => {
    const e = { ...baseEvent, key: "Dead", shiftKey: true };
    expect(decideKeyAction(e, true, false)).toBe("pass");
  });

  it("does NOT intercept Cmd+Shift+letter (Mac modifier combo)", () => {
    const e = { ...baseEvent, key: "C", shiftKey: true, metaKey: true };
    expect(decideKeyAction(e, true, false)).not.toBe("shift-direct");
  });

  it("does NOT intercept Ctrl+Shift+letter or Alt+Shift+letter", () => {
    expect(
      decideKeyAction({ ...baseEvent, key: "A", shiftKey: true, ctrlKey: true }, true, false),
    ).not.toBe("shift-direct");
    expect(
      decideKeyAction({ ...baseEvent, key: "A", shiftKey: true, altKey: true }, true, false),
    ).not.toBe("shift-direct");
  });
});

// ============================================================================
// Ctrl+C smart copy (#8)
// ============================================================================
describe("decideKeyAction — Ctrl+C smart copy / SIGINT", () => {
  const base: KeyEventLike = {
    type: "keydown",
    key: "c",
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
  };

  it("Win/Lin Ctrl+C with selection → copy", () => {
    expect(decideKeyAction(base, false, true)).toBe("copy");
  });

  it("Win/Lin Ctrl+C without selection → pass (sends SIGINT)", () => {
    expect(decideKeyAction(base, false, false)).toBe("pass");
  });

  it("Win/Lin Ctrl+Shift+C always copies regardless of selection", () => {
    const e = { ...base, key: "C", shiftKey: true };
    expect(decideKeyAction(e, false, false)).toBe("copy");
    expect(decideKeyAction(e, false, true)).toBe("copy");
  });

  it("Mac Cmd+C copies", () => {
    const e = { ...base, ctrlKey: false, metaKey: true };
    expect(decideKeyAction(e, true, true)).toBe("copy");
    expect(decideKeyAction(e, true, false)).toBe("copy");
  });

  it("Mac Ctrl+C without selection → pass (preserves SIGINT)", () => {
    expect(decideKeyAction(base, true, false)).toBe("pass");
  });
});

// ============================================================================
// Ctrl+V / Cmd+V paste
// ============================================================================
describe("decideKeyAction — paste", () => {
  const base: KeyEventLike = {
    type: "keydown",
    key: "v",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
  };

  it("Win/Lin Ctrl+V → paste", () => {
    expect(decideKeyAction({ ...base, ctrlKey: true }, false, false)).toBe("paste");
  });

  it("Win/Lin Ctrl+Shift+V → paste", () => {
    expect(decideKeyAction({ ...base, ctrlKey: true, shiftKey: true, key: "V" }, false, false)).toBe("paste");
  });

  it("Mac Cmd+V → paste", () => {
    expect(decideKeyAction({ ...base, metaKey: true }, true, false)).toBe("paste");
  });

  it("plain V key → pass", () => {
    expect(decideKeyAction({ ...base, key: "V" }, false, false)).toBe("pass");
  });
});

// ============================================================================
// Right-click smart copy/paste (#7 — Windows Terminal style)
// ============================================================================
describe("decideRightClick", () => {
  it("returns 'copy' when text is selected", () => {
    expect(decideRightClick(true)).toBe("copy");
  });
  it("returns 'paste' when no selection", () => {
    expect(decideRightClick(false)).toBe("paste");
  });
});

// ============================================================================
// D&D position-based session targeting (#1)
// ============================================================================
describe("findDropTargetSession", () => {
  let doc: Document;

  beforeEach(() => {
    // Build a fake DOM with two terminal panes
    doc = document.implementation.createHTMLDocument("test");
    doc.body.innerHTML = `
      <div id="grid">
        <div data-session-id="session-A" style="position:absolute;left:0;top:0;width:200px;height:200px"></div>
        <div data-session-id="session-B" style="position:absolute;left:200px;top:0;width:200px;height:200px"></div>
      </div>
    `;

    // jsdom doesn't compute layout, so monkey-patch elementFromPoint
    // to return whichever pane covers the requested coordinates.
    (doc as any).elementFromPoint = (x: number, y: number): Element | null => {
      if (x < 0 || y < 0 || y >= 200) return null;
      if (x < 200) return doc.querySelector('[data-session-id="session-A"]');
      if (x < 400) return doc.querySelector('[data-session-id="session-B"]');
      return null;
    };
  });

  it("Win/Linux: returns the session id of the pane at the drop position (scale=1)", () => {
    expect(findDropTargetSession({ x: 100, y: 100 }, 1, doc, null, false)).toBe("session-A");
    expect(findDropTargetSession({ x: 300, y: 100 }, 1, doc, null, false)).toBe("session-B");
  });

  it("Win/Linux: divides by devicePixelRatio for high-DPI displays (Tauri reports physical px)", () => {
    // Position (200, 200) physical at scale=2 = (100, 100) logical = session-A
    expect(findDropTargetSession({ x: 200, y: 200 }, 2, doc, null, false)).toBe("session-A");
    // Position (600, 200) physical = (300, 100) logical = session-B
    expect(findDropTargetSession({ x: 600, y: 200 }, 2, doc, null, false)).toBe("session-B");
    // Non-integer DPI (Windows 125%, 150%)
    expect(findDropTargetSession({ x: 125, y: 125 }, 1.25, doc, null, false)).toBe("session-A");
    expect(findDropTargetSession({ x: 450, y: 150 }, 1.5, doc, null, false)).toBe("session-B");
  });

  it("Mac: does NOT divide by devicePixelRatio (wry already returns logical points)", () => {
    // The bug was: on Mac Retina (scale=2), dividing collapsed coords to top-left 1/4.
    // Now Mac uses raw coordinates. Position (300, 100) logical = session-B regardless of scale.
    expect(findDropTargetSession({ x: 300, y: 100 }, 2, doc, null, true)).toBe("session-B");
    expect(findDropTargetSession({ x: 300, y: 100 }, 1, doc, null, true)).toBe("session-B");
    // The buggy behavior would have returned session-A (300/2 = 150 < 200).
  });

  it("Mac: a drop on the right pane at logical position 300 stays on the right pane", () => {
    // Regression test for the wry / Tauri Issue #10744 fix
    expect(findDropTargetSession({ x: 350, y: 50 }, 2, doc, "fallback", true)).toBe("session-B");
  });

  it("returns fallback when position resolves to no pane (e.g. sidebar)", () => {
    expect(findDropTargetSession({ x: 9999, y: 9999 }, 1, doc, "fallback-session", false)).toBe(
      "fallback-session",
    );
  });

  it("returns fallback when position is undefined", () => {
    expect(findDropTargetSession(undefined, 1, doc, "fb", false)).toBe("fb");
  });

  it("handles nested children inside a pane (closest()), not just direct elements", () => {
    const pane = doc.querySelector('[data-session-id="session-A"]') as HTMLElement;
    const child = doc.createElement("span");
    child.textContent = "inner";
    pane.appendChild(child);
    (doc as any).elementFromPoint = () => child;
    expect(findDropTargetSession({ x: 50, y: 50 }, 1, doc, null, false)).toBe("session-A");
  });
});

// ============================================================================
// Path → shell args formatting (used in +File and D&D)
// ============================================================================
describe("pathsToShellArgs — basic formatting", () => {
  it("wraps each path in double quotes with trailing space", () => {
    expect(pathsToShellArgs(["/Users/me/foo.txt"])).toBe('"/Users/me/foo.txt" ');
  });

  it("joins multiple paths with spaces", () => {
    expect(pathsToShellArgs(["/a", "/b"])).toBe('"/a" "/b" ');
  });

  it("escapes embedded double quotes", () => {
    expect(pathsToShellArgs(['/path/with"quote'])).toBe('"/path/with\\"quote" ');
  });

  it("escapes backslashes", () => {
    expect(pathsToShellArgs(["C:\\Users\\me"])).toBe('"C:\\\\Users\\\\me" ');
  });

  it("returns empty string for empty array (no trailing space)", () => {
    expect(pathsToShellArgs([])).toBe("");
  });

  it("preserves Unicode (CJK, emoji)", () => {
    expect(pathsToShellArgs(["/写真/猫🐈.jpg"])).toBe('"/写真/猫🐈.jpg" ');
  });
});

describe("pathsToShellArgs — SECURITY: shell injection prevention", () => {
  // These tests guard against command injection via malicious filenames.
  // POSIX double quotes still allow $, `, and \ to be active.

  it("escapes $ to prevent variable expansion (CRITICAL)", () => {
    const result = pathsToShellArgs(["/tmp/$HOME"]);
    // The $ must be backslash-escaped so the shell sees a literal $
    expect(result).toBe('"/tmp/\\$HOME" ');
    // No unescaped $ (every $ must be preceded by \)
    expect(result).not.toMatch(/[^\\]\$/);
  });

  it("escapes $() to prevent command substitution (CRITICAL)", () => {
    const result = pathsToShellArgs(["/tmp/$(rm -rf ~).txt"]);
    expect(result).toContain("\\$");
    // The $( must not appear unescaped
    expect(result).not.toMatch(/[^\\]\$\(/);
  });

  it("escapes backticks to prevent legacy command substitution (CRITICAL)", () => {
    const result = pathsToShellArgs(["/tmp/`whoami`.txt"]);
    expect(result).toContain("\\`");
    expect(result).not.toMatch(/[^\\]`/);
  });

  it("strips newlines so a path can't break out into a new shell command", () => {
    const result = pathsToShellArgs(["/tmp/foo.txt\nrm -rf ~"]);
    // Newline must NOT survive — rm should not appear on its own line
    expect(result).not.toContain("\n");
    expect(result).not.toContain("\r");
  });

  it("escapes ! (history expansion in interactive bash)", () => {
    const result = pathsToShellArgs(["/tmp/!important.txt"]);
    expect(result).toContain("\\!");
  });

  it("handles multiple injection vectors combined", () => {
    const evil = '/tmp/$(id)`whoami`"hi"\\path';
    const result = pathsToShellArgs([evil]);
    // Every special char escaped
    expect(result).toContain("\\$");
    expect(result).toContain("\\`");
    expect(result).toContain('\\"');
    expect(result).toContain("\\\\");
  });

  it("does NOT mangle a normal path with safe characters", () => {
    expect(pathsToShellArgs(["/Users/me/Documents/foo bar.txt"])).toBe(
      '"/Users/me/Documents/foo bar.txt" ',
    );
  });
});
