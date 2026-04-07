import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Verify CSS-level fixes by parsing App.css directly.
 *  - I-beam cursor inside xterm (#6)
 *  - user-select: text override inside xterm (so text can be selected
 *    despite the global user-select: none on body)
 */
describe("App.css — terminal cursor and selection", () => {
  let css: string;

  beforeAll(() => {
    css = readFileSync(resolve(__dirname, "../../src/App.css"), "utf-8");
  });

  it("globally disables user-select on html/body/#root", () => {
    expect(css).toMatch(/html,\s*body,\s*#root\s*\{[^}]*user-select:\s*none/);
  });

  it("overrides user-select to text inside .xterm", () => {
    // Two rules: .xterm/* and .xterm .xterm-screen — make sure both restore
    // text selection so the global user-select:none doesn't kill it.
    expect(css).toMatch(/\.xterm[\s\S]*?user-select:\s*text/);
    expect(css).toMatch(/\.xterm[\s\S]*?-webkit-user-select:\s*text/);
  });

  it("sets I-beam cursor on .xterm", () => {
    expect(css).toMatch(/\.xterm[\s\S]*?cursor:\s*text/);
  });

  it("sets I-beam cursor on .xterm-screen specifically", () => {
    expect(css).toMatch(/\.xterm\s+\.xterm-screen[\s\S]*?cursor:\s*text/);
  });
});

/**
 * Verify the layout fix for "input pane right edge stretches" (#5).
 * The fix is adding `min-w-0` to the TerminalPane root and termRef divs.
 * Without this, flex children default to min-width:auto and grow with content.
 */
describe("TerminalPane.tsx — wrap fix layout", () => {
  let source: string;

  beforeAll(() => {
    source = readFileSync(
      resolve(__dirname, "../../src/components/TerminalPane.tsx"),
      "utf-8",
    );
  });

  it("root div has min-w-0 and w-full and overflow-hidden", () => {
    // The root div line that includes ref={rootRef} and the className.
    const rootMatch = source.match(/ref=\{rootRef\}[\s\S]*?className=\{[^\}]*\}/);
    expect(rootMatch, "must find root div").not.toBeNull();
    const cls = rootMatch![0];
    expect(cls).toContain("min-w-0");
    expect(cls).toContain("w-full");
    expect(cls).toContain("overflow-hidden");
  });

  it("xterm container div (termRef) has min-w-0 and overflow-hidden", () => {
    const termRefMatch = source.match(/ref=\{termRef\}[\s\S]*?className="[^"]*"/);
    expect(termRefMatch, "must find termRef div").not.toBeNull();
    expect(termRefMatch![0]).toContain("min-w-0");
    expect(termRefMatch![0]).toContain("overflow-hidden");
  });

  it("xterm Terminal is constructed with rightClickSelectsWord: false", () => {
    expect(source).toMatch(/rightClickSelectsWord:\s*false/);
  });
});

/**
 * Verify TerminalGrid fix for D&D + multi-pane min-w-0
 */
describe("TerminalGrid.tsx — pane wrappers have min-w-0", () => {
  let source: string;

  beforeAll(() => {
    source = readFileSync(
      resolve(__dirname, "../../src/components/TerminalGrid.tsx"),
      "utf-8",
    );
  });

  it("focus layout side panel container has min-w-0", () => {
    expect(source).toMatch(/flex\s+flex-col[^"]*min-w-0[^"]*overflow-hidden[^"]*border-l/);
  });

  it("focus layout side panel items have min-w-0", () => {
    expect(source).toMatch(/flex-1[^"]*min-w-0[^"]*overflow-hidden[^"]*border-b/);
  });

  it("grid layout cell wrapper has min-h-0 and min-w-0", () => {
    expect(source).toMatch(/min-h-0\s+min-w-0\s+overflow-hidden/);
  });
});
