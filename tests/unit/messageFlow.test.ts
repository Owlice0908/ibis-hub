import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * +File flow regression test (#2)
 *
 * The bug: clicking +File on session B would paste the picked files into
 * the *focused* session (often session A on the left), not B.
 *
 * Root causes verified here:
 *  1. server.mjs `pick_files` reply must include `sessionId: msg.sessionId`
 *  2. App.tsx `files_picked` handler must use `msg.sessionId` only,
 *     never falling back to `focusedSessionIdRef.current`
 *  3. TerminalPane +File button must pass `sessionId` in the request
 *  4. useTauriTransport `pick_files` must propagate `sessionId` end-to-end
 */
describe("+File sessionId routing — full chain", () => {
  it("server.mjs pick_files reply includes msg.sessionId", () => {
    const source = readFileSync(resolve(__dirname, "../../server.mjs"), "utf-8");
    // The fix line:
    expect(source).toMatch(
      /ws\.send\(JSON\.stringify\(\{\s*type:\s*"files_picked",\s*paths,\s*sessionId:\s*msg\.sessionId\s*\}\)\)/,
    );
  });

  it("App.tsx files_picked handler uses msg.sessionId only (no focused fallback)", () => {
    const source = readFileSync(resolve(__dirname, "../../src/App.tsx"), "utf-8");
    // Find the files_picked case
    const match = source.match(/case "files_picked":[\s\S]*?break;/);
    expect(match, "files_picked handler must exist").not.toBeNull();
    const handler = match![0];

    // It must NOT contain the buggy fallback
    expect(handler).not.toMatch(/msg\.sessionId\s*\|\|\s*focusedSessionIdRef/);
    // It must use msg.sessionId
    expect(handler).toMatch(/const targetId = msg\.sessionId/);
  });

  it("TerminalPane +File button passes sessionId in pick_files request", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/components/TerminalPane.tsx"),
      "utf-8",
    );
    expect(source).toMatch(
      /wsSend\(\{\s*type:\s*"pick_files",\s*sessionId\s*\}\)/,
    );
  });

  it("useTauriTransport pick_files propagates sessionId in files_picked emit", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/useTauriTransport.ts"),
      "utf-8",
    );
    expect(source).toMatch(
      /emit\(\{\s*type:\s*"files_picked",\s*paths,\s*sessionId:\s*msg\.sessionId\s*\}\)/,
    );
  });
});

/**
 * Right-click smart copy/paste (#7)
 *
 * The bug: right-clicking a selected URL opened the link instead of copying.
 *
 * Fix: TerminalPane registers a contextmenu listener on the terminal container
 * that calls preventDefault() and either copies the selection or pastes from
 * the clipboard.
 */
describe("Right-click smart copy/paste handler", () => {
  let source: string;

  beforeAll(() => {
    source = readFileSync(
      resolve(__dirname, "../../src/components/TerminalPane.tsx"),
      "utf-8",
    );
  });

  it("imports decideRightClick from terminalUtils", () => {
    // Critical: the unit-tested pure function must actually be imported.
    // Without this import the unit tests of decideRightClick would be lying.
    expect(source).toMatch(/import\s*\{[^}]*decideRightClick[^}]*\}\s*from\s*["']\.\.\/lib\/terminalUtils["']/);
  });

  it("calls decideRightClick(terminal.hasSelection()) inside handleContextMenu", () => {
    expect(source).toMatch(/decideRightClick\(\s*terminal\.hasSelection\(\)\s*\)/);
  });

  it("registers a contextmenu listener with capture phase", () => {
    // Capture phase ensures we win over any addon that might attach to a child.
    expect(source).toMatch(
      /addEventListener\(\s*"contextmenu",\s*handleContextMenu,\s*true\s*\)/,
    );
  });

  it("removes the contextmenu listener on unmount with matching capture flag", () => {
    expect(source).toMatch(
      /removeEventListener\(\s*"contextmenu",\s*handleContextMenu,\s*true\s*\)/,
    );
  });

  it("contextmenu handler calls preventDefault and stopPropagation", () => {
    const match = source.match(
      /const handleContextMenu = \(e: MouseEvent\) => \{[\s\S]*?\n    \};/,
    );
    expect(match, "handler must exist").not.toBeNull();
    const handler = match![0];
    expect(handler).toContain("e.preventDefault()");
    expect(handler).toContain("e.stopPropagation()");
  });

  it("disables xterm built-in rightClickSelectsWord (so our handler wins)", () => {
    expect(source).toMatch(/rightClickSelectsWord:\s*false/);
  });
});

/**
 * D&D Tauri native bridging (#1)
 *
 * App.tsx must:
 *  - Listen to onDragDropEvent on Tauri
 *  - Use position-based session targeting (findDropTargetSession)
 *  - Dispatch ibis-native-dragover/dragleave/drop custom events for visual FB
 *
 * TerminalPane.tsx must:
 *  - Listen to those custom events (Tauri mode only)
 *  - Disable DOM D&D handlers in Tauri mode (avoid conflict)
 *  - Have data-session-id attribute on the root for hit-testing
 */
describe("Drag & drop bridging", () => {
  it("App.tsx registers onDragDropEvent listener with position-based targeting", () => {
    const source = readFileSync(resolve(__dirname, "../../src/App.tsx"), "utf-8");
    expect(source).toMatch(/onDragDropEvent\(/);
    expect(source).toMatch(/findDropTargetSession\(/);
    expect(source).toMatch(/CustomEvent\("ibis-native-dragover"/);
    expect(source).toMatch(/CustomEvent\("ibis-native-dragleave"/);
    expect(source).toMatch(/CustomEvent\("ibis-native-drop"/);
  });

  it("App.tsx passes IS_MAC flag to findDropTargetSession (wry coordinate fix)", () => {
    const source = readFileSync(resolve(__dirname, "../../src/App.tsx"), "utf-8");
    // The IS_MAC constant must exist
    expect(source).toMatch(/const IS_MAC\s*=/);
    // findDropTargetSession must be called with IS_MAC as the 5th arg
    expect(source).toMatch(/findDropTargetSession\([\s\S]*?IS_MAC[\s\S]*?\)/);
  });

  it("TerminalPane handleDragOver uses dndPositionToLogical with IS_MAC", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/components/TerminalPane.tsx"),
      "utf-8",
    );
    expect(source).toMatch(/import\s*\{[^}]*dndPositionToLogical[^}]*\}/);
    expect(source).toMatch(/dndPositionToLogical\([^)]*IS_MAC[^)]*\)/);
  });

  it("TerminalPane has data-session-id attribute on root", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/components/TerminalPane.tsx"),
      "utf-8",
    );
    expect(source).toMatch(/data-session-id=\{sessionId\}/);
  });

  it("TerminalPane listens for native D&D custom events in Tauri mode", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/components/TerminalPane.tsx"),
      "utf-8",
    );
    expect(source).toMatch(/addEventListener\("ibis-native-dragover"/);
    expect(source).toMatch(/addEventListener\("ibis-native-dragleave"/);
    expect(source).toMatch(/addEventListener\("ibis-native-drop"/);
  });

  it("TerminalPane DOM D&D handlers are gated by !isTauri", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/components/TerminalPane.tsx"),
      "utf-8",
    );
    expect(source).toMatch(/\{\.\.\.\(!isTauri\s*\?\s*\{[\s\S]*?onDragEnter:/);
  });
});

/**
 * NSOpenPanel main thread dispatch (#3)
 * Verifies the Rust source actually uses run_on_main_thread for Cocoa calls.
 */
describe("Rust pick_files_macos main thread dispatch", () => {
  it("calls app.run_on_main_thread before NSOpenPanel", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src-tauri/src/lib.rs"),
      "utf-8",
    );
    // The fix: pick_files_macos takes AppHandle and dispatches via run_on_main_thread
    expect(source).toMatch(/fn pick_files_macos\(_app: tauri::AppHandle\)/);
    expect(source).toMatch(/run_on_main_thread\(/);
    expect(source).toMatch(/NSOpenPanel/);
  });

  it("waits on a channel for the main-thread result", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src-tauri/src/lib.rs"),
      "utf-8",
    );
    expect(source).toMatch(/std::sync::mpsc/);
    expect(source).toMatch(/rx\.recv\(\)/);
  });
});
