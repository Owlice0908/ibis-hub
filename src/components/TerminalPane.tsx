import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import type { ThemeMode } from "../types";
import {
  decideKeyAction,
  decideRightClick,
  isAmbiguousWide,
  isForceNarrow,
  dndPositionToLogical,
} from "../lib/terminalUtils";
import wcwidth from "wcwidth";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const IS_MAC = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");

const DARK_THEME = {
  background: "#0f0f0f",
  foreground: "#e5e5e5",
  cursor: "#e5e5e5",
  selectionBackground: "#6366f1aa",
  black: "#0f0f0f",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#f59e0b",
  blue: "#6366f1",
  magenta: "#a855f7",
  cyan: "#06b6d4",
  white: "#e5e5e5",
  brightBlack: "#555555",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#fbbf24",
  brightBlue: "#818cf8",
  brightMagenta: "#c084fc",
  brightCyan: "#22d3ee",
  brightWhite: "#ffffff",
};

const LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#1a1a1a",
  cursor: "#1a1a1a",
  selectionBackground: "#4f46e5aa",
  black: "#1a1a1a",
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#d97706",
  blue: "#4f46e5",
  magenta: "#9333ea",
  cyan: "#0891b2",
  white: "#f5f5f5",
  brightBlack: "#737373",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#f59e0b",
  brightBlue: "#6366f1",
  brightMagenta: "#a855f7",
  brightCyan: "#06b6d4",
  brightWhite: "#ffffff",
};

interface TerminalPaneProps {
  sessionId: string;
  sessionName: string;
  showControls: boolean;
  isVisible: boolean;
  theme: ThemeMode;
  wsSend: (msg: any) => void;
  wsOnMessage: (handler: (msg: any) => void) => () => void;
  onDetach: () => void;
  onClose: () => void;
}

export default function TerminalPane({
  sessionId,
  sessionName,
  showControls,
  isVisible,
  theme,
  wsSend,
  wsOnMessage,
  onDetach,
  onClose,
}: TerminalPaneProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleRef = useRef(isVisible);
  const bufferedDataRef = useRef("");
  const [dragOver, setDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const MAX_UPLOAD_SIZE = 100 * 1024 * 1024; // 100MB
  const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB max buffer for hidden terminals

  const handleResize = useCallback(() => {
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      const fitAddon = fitAddonRef.current;
      const terminal = terminalRef.current;
      const container = termRef.current;
      if (fitAddon && terminal && container) {
        // Skip resize when the pane is hidden offscreen (e.g. 1x1px)
        const rect = container.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return;
        try {
          fitAddon.fit();
          const cols = Math.max(terminal.cols, 20);
          const rows = Math.max(terminal.rows, 4);
          if (cols !== terminal.cols || rows !== terminal.rows) {
            terminal.resize(cols, rows);
          }
          wsSend({ type: "resize", id: sessionId, cols, rows });
        } catch {}
      }
    }, 50);
  }, [sessionId, wsSend]);

  // Upload dropped file to server, get path back, send to PTY
  const handleFileDrop = useCallback((files: FileList) => {
    Array.from(files).forEach((file) => {
      if (file.size > MAX_UPLOAD_SIZE) {
        console.warn(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB): ${file.name}`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        wsSend({
          type: "upload_file",
          name: file.name,
          data: base64,
          sessionId,
        });
      };
      reader.readAsDataURL(file);
    });
  }, [wsSend, sessionId]);

  // Tauri-only: native drag-and-drop visual feedback via custom events from App.tsx
  useEffect(() => {
    if (!isTauri) return;
    const root = rootRef.current;
    if (!root) return;

    const handleDragOver = (e: Event) => {
      const { x, y } = (e as CustomEvent).detail;
      const scale = window.devicePixelRatio || 1;
      const rect = root.getBoundingClientRect();
      // Use the same Mac/non-Mac logic as App.tsx via the shared helper.
      const { x: cx, y: cy } = dndPositionToLogical({ x, y }, scale, IS_MAC);
      const isOver = cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom;
      setDragOver(isOver);
    };

    const handleClear = () => setDragOver(false);

    window.addEventListener("ibis-native-dragover", handleDragOver);
    window.addEventListener("ibis-native-dragleave", handleClear);
    window.addEventListener("ibis-native-drop", handleClear);

    return () => {
      window.removeEventListener("ibis-native-dragover", handleDragOver);
      window.removeEventListener("ibis-native-dragleave", handleClear);
      window.removeEventListener("ibis-native-drop", handleClear);
    };
  }, []);

  // Flush buffered data, refit, and scroll to bottom when becoming visible
  useEffect(() => {
    visibleRef.current = isVisible;
    if (isVisible && terminalRef.current) {
      const terminal = terminalRef.current;
      if (bufferedDataRef.current) {
        terminal.write(bufferedDataRef.current);
        bufferedDataRef.current = "";
      }
      requestAnimationFrame(() => {
        try {
          fitAddonRef.current?.fit();
        } catch {}
        terminal.scrollToBottom();
      });
    }
  }, [isVisible]);

  // Update terminal theme when theme changes
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = theme === "dark" ? DARK_THEME : LIGHT_THEME;
    }
  }, [theme]);

  useEffect(() => {
    if (!termRef.current) return;

    const terminal = new Terminal({
      theme: theme === "dark" ? DARK_THEME : LIGHT_THEME,
      fontFamily: "'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Source Han Mono', 'Noto Sans Mono CJK JP', 'MS Gothic', monospace",
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: false,
      cursorStyle: "bar",
      scrollback: 1000,
      allowProposedApi: true,
      rightClickSelectsWord: false, // We handle right-click ourselves (copy/paste)
      smoothScrollDuration: 0,
    });

    // Copy/paste shortcuts (Ctrl+Shift+C/V for Linux/Windows, Cmd+C/V for Mac)
    const isMac = navigator.platform.toLowerCase().includes("mac");
    terminal.attachCustomKeyEventHandler((e) => {
      // Delegate the decision to a pure function so it stays unit-testable.
      // See src/lib/terminalUtils.ts and tests/unit/terminalUtils.test.ts.
      const decision = decideKeyAction(
        {
          type: e.type,
          key: e.key,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          isComposing: e.isComposing,
        },
        isMac,
        terminal.hasSelection(),
      );

      if (decision === "shift-direct") {
        wsSend({ type: "write", id: sessionId, data: e.key });
        return false;
      }
      if (decision === "copy") {
        const sel = terminal.getSelection();
        if (sel) {
          navigator.clipboard.writeText(sel).catch(() => {});
          terminal.clearSelection();
        }
        return false;
      }
      if (decision === "paste") {
        navigator.clipboard
          .readText()
          .then((text) => {
            wsSend({ type: "write", id: sessionId, data: text });
          })
          .catch(() => {
            // Clipboard access denied or unavailable — ignore silently
          });
        return false;
      }
      // Select + Backspace/Delete: delete selected text by sending backspaces
      if (e.key === "Backspace" || e.key === "Delete") {
        const sel = terminal.getSelection();
        if (sel && sel.length > 0) {
          terminal.clearSelection();
          const backspaces = "\x7f".repeat(sel.length);
          wsSend({ type: "write", id: sessionId, data: backspaces });
          return false;
        }
      }
      return true;
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const unicode11Addon = new Unicode11Addon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.loadAddon(unicode11Addon);
    terminal.unicode.activeVersion = "11";

    // CJK-aware unicode provider. Uses the `wcwidth` npm package for base
    // width (POSIX-standard Unicode width table) instead of xterm.js internal
    // API, which was unreliable and caused both "dotted borders" and
    // "overlapping characters" bugs.
    //
    // Priority:
    //   1. isForceNarrow(cp) → 1  (box drawing, arrows, blocks — TUI borders)
    //   2. isAmbiguousWide(cp) → 2  (①②③ — user's original request)
    //   3. wcwidth(cp)  → standard POSIX width (CJK=2, ASCII=1, etc.)
    try {
      const safeWcwidth = (cp: number): 0 | 1 | 2 => {
        if (isForceNarrow(cp)) return 1;
        if (isAmbiguousWide(cp)) return 2;
        const w = wcwidth(String.fromCodePoint(cp));
        if (w <= 0) return (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) ? 0 : 1;
        return (w >= 2 ? 2 : 1) as 0 | 1 | 2;
      };

      const cjkProvider = {
        version: "cjk",
        wcwidth: safeWcwidth,
        charProperties: (codepoint: number, _preceding: number): number => {
          // xterm.js v6 bit layout: bit 0 = shouldJoin, bits 1-2 = width
          const w = safeWcwidth(codepoint);
          return (w << 1);
        },
      };
      terminal.unicode.register(cjkProvider as any);
      terminal.unicode.activeVersion = "cjk";
    } catch (e) {
      console.warn("CJK unicode provider registration failed:", e);
    }

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Clear container before opening (prevents duplicate terminals from StrictMode remounts)
    while (termRef.current.firstChild) {
      termRef.current.removeChild(termRef.current.firstChild);
    }
    terminal.open(termRef.current);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          fitAddon.fit();
          wsSend({
            type: "resize",
            id: sessionId,
            cols: terminal.cols,
            rows: terminal.rows,
          });
        } catch {}
      });
    });

    // Guard: when effect re-runs or cleans up, mark this instance as dead
    // so no stale closure can write to a disposed terminal
    let alive = true;

    // PTY output from server
    let pendingData = "";
    let writeScheduled = false;
    const flushWrite = () => {
      if (!alive) return;
      if (pendingData) {
        terminal.write(pendingData);
        pendingData = "";
      }
      writeScheduled = false;
    };

    const unsubscribe = wsOnMessage((msg: any) => {
      if (!alive) return;
      if (msg.type === "pty_output" && msg.id === sessionId) {
        // Buffer data when hidden, write directly when visible
        if (!visibleRef.current) {
          bufferedDataRef.current += msg.data;
          // Cap buffer to prevent OOM with fast output on hidden terminals
          if (bufferedDataRef.current.length > MAX_BUFFER_SIZE) {
            bufferedDataRef.current = bufferedDataRef.current.slice(-MAX_BUFFER_SIZE);
          }
          return;
        }
        pendingData += msg.data;
        if (!writeScheduled) {
          writeScheduled = true;
          requestAnimationFrame(flushWrite);
        }
      }
      if (msg.type === "session_exited" && msg.id === sessionId) {
        terminal.write("\r\n\x1b[90m[Session ended]\x1b[0m\r\n");
      }
      // File uploaded → send path to PTY
      if (msg.type === "file_uploaded" && msg.sessionId === sessionId) {
        const escaped = msg.path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        wsSend({ type: "write", id: sessionId, data: `"${escaped}" ` });
      }
    });

    // Send user input to server
    const onData = terminal.onData((data) => {
      if (!alive) return;
      wsSend({ type: "write", id: sessionId, data });
    });

    // Right-click: Windows Terminal style smart copy/paste.
    // The copy-vs-paste decision is delegated to the unit-tested
    // `decideRightClick` pure function so test and production stay in sync.
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!alive) return;
      const action = decideRightClick(terminal.hasSelection());
      if (action === "copy") {
        const sel = terminal.getSelection();
        if (sel) {
          navigator.clipboard.writeText(sel).catch(() => {});
          terminal.clearSelection();
        }
      } else {
        navigator.clipboard
          .readText()
          .then((text) => {
            if (alive) wsSend({ type: "write", id: sessionId, data: text });
          })
          .catch(() => {});
      }
    };
    const containerEl = termRef.current;
    // Use capture phase so we win over any addon (e.g. WebLinksAddon) that
    // might attach a contextmenu listener on a child element.
    containerEl?.addEventListener("contextmenu", handleContextMenu, true);

    const observer = new ResizeObserver(() => handleResize());
    observer.observe(termRef.current);

    return () => {
      alive = false;
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      observer.disconnect();
      containerEl?.removeEventListener("contextmenu", handleContextMenu, true);
      onData.dispose();
      unsubscribe();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId, handleResize, wsSend, wsOnMessage]);

  return (
    <div
      ref={rootRef}
      data-session-id={sessionId}
      className={`flex flex-col bg-bg min-h-0 h-full relative ${dragOver ? "ring-2 ring-accent ring-inset" : ""}`}
      {...(!isTauri ? {
        onDragEnter: (e: React.DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          dragDepthRef.current++;
          setDragOver(true);
        },
        onDragOver: (e: React.DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
        },
        onDragLeave: (e: React.DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          dragDepthRef.current--;
          if (dragDepthRef.current <= 0) {
            dragDepthRef.current = 0;
            setDragOver(false);
          }
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          dragDepthRef.current = 0;
          setDragOver(false);
          if (e.dataTransfer.files.length > 0) {
            handleFileDrop(e.dataTransfer.files);
          }
        },
      } : {})}
    >
      <div className="flex items-center justify-between px-2 py-1 bg-surface border-b border-border">
        <span className="text-sm text-text-muted font-medium truncate">{sessionName}</span>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => wsSend({ type: "pick_files", sessionId })}
            className="text-base text-accent hover:text-accent-hover px-3 py-1 rounded hover:bg-surface-hover font-medium"
            title="ファイル・フォルダ選択"
          >
            + File
          </button>
          {showControls && (
            <>
            <button
              onClick={onDetach}
              className="text-xs text-text-muted hover:text-text px-1.5 py-0.5 rounded hover:bg-surface-hover"
              title="Detach from grid"
            >
              ⊟
            </button>
            <button
              onClick={onClose}
              className="text-xs text-text-muted hover:text-danger px-1.5 py-0.5 rounded hover:bg-surface-hover"
              title="Close session"
            >
              ✕
            </button>
            </>
          )}
        </div>
      </div>
      <div ref={termRef} className="flex-1 min-h-0 min-w-0 overflow-hidden" />
      {dragOver && (
        <div className="absolute inset-0 bg-accent/10 flex items-center justify-center pointer-events-none z-10">
          <div className="bg-surface border border-accent rounded-lg px-6 py-3 text-text font-medium shadow-lg pointer-events-none">
            Drop files here
          </div>
        </div>
      )}
    </div>
  );
}
