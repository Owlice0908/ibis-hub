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

  it("returns 'shift-direct' for Mac Shift+A (uppercase letter)", () => {
    const e = { ...baseEvent, key: "A", shiftKey: true };
    expect(decideKeyAction(e, true, false)).toBe("shift-direct");
  });

  it("returns 'shift-direct' for Mac Shift+! (shift+symbol)", () => {
    const e = { ...baseEvent, key: "!", shiftKey: true };
    expect(decideKeyAction(e, true, false)).toBe("shift-direct");
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

  it("does NOT return 'shift-direct' for shift + Tab", () => {
    const e = { ...baseEvent, key: "Tab", shiftKey: true };
    expect(decideKeyAction(e, true, false)).toBe("pass");
  });

  it("does NOT intercept Cmd+Shift+letter (Mac modifier combo)", () => {
    const e = { ...baseEvent, key: "C", shiftKey: true, metaKey: true };
    // Cmd+Shift+C is not the standard copy on Mac (that's Cmd+C),
    // but importantly we should NOT shift-direct it.
    expect(decideKeyAction(e, true, false)).not.toBe("shift-direct");
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

  it("returns the session id of the pane at the drop position", () => {
    expect(findDropTargetSession({ x: 100, y: 100 }, 1, doc, null)).toBe("session-A");
    expect(findDropTargetSession({ x: 300, y: 100 }, 1, doc, null)).toBe("session-B");
  });

  it("divides by devicePixelRatio for retina displays", () => {
    // On Mac retina (scale=2), Tauri reports physical pixels.
    // Position (200, 200) physical = (100, 100) logical = session-A
    expect(findDropTargetSession({ x: 200, y: 200 }, 2, doc, null)).toBe("session-A");
    // Position (600, 200) physical = (300, 100) logical = session-B
    expect(findDropTargetSession({ x: 600, y: 200 }, 2, doc, null)).toBe("session-B");
  });

  it("returns fallback when position resolves to no pane (e.g. sidebar)", () => {
    expect(findDropTargetSession({ x: 9999, y: 9999 }, 1, doc, "fallback-session")).toBe(
      "fallback-session",
    );
  });

  it("returns fallback when position is undefined", () => {
    expect(findDropTargetSession(undefined, 1, doc, "fb")).toBe("fb");
  });

  it("handles nested children inside a pane (closest()), not just direct elements", () => {
    const pane = doc.querySelector('[data-session-id="session-A"]') as HTMLElement;
    const child = doc.createElement("span");
    child.textContent = "inner";
    pane.appendChild(child);
    (doc as any).elementFromPoint = () => child;
    expect(findDropTargetSession({ x: 50, y: 50 }, 1, doc, null)).toBe("session-A");
  });
});

// ============================================================================
// Path → shell args formatting (used in +File and D&D)
// ============================================================================
describe("pathsToShellArgs", () => {
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

  it("returns just trailing space for empty array", () => {
    expect(pathsToShellArgs([])).toBe(" ");
  });
});
