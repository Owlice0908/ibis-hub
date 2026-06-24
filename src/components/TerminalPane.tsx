import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import type { ThemeMode, TerminalMode, PaneRect } from "../types";
import {
  decideKeyAction,
  decideRightClick,
  dndPositionToLogical,
} from "../lib/terminalUtils";
import { useNativeTerminalRect } from "../hooks/useNativeTerminalRect";

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
  // ペインのターミナルモード。未指定 = "xterm"(既存挙動)。
  // "native" は Tauri Win/Mac で OS 純正端末をペイン矩形に重ねる試作モード。
  terminalMode?: TerminalMode;
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
  terminalMode = "xterm",
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

  const safeFit = useCallback((fitAddon: FitAddon, terminal: Terminal) => {
    const dims = fitAddon.proposeDimensions();
    if (!dims || isNaN(dims.cols) || isNaN(dims.rows)) return null;
    const cols = Math.max(dims.cols - 1, 20);
    const rows = Math.max(dims.rows, 4);
    terminal.resize(cols, rows);
    return { cols, rows };
  }, []);

  const handleResize = useCallback(() => {
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      const fitAddon = fitAddonRef.current;
      const terminal = terminalRef.current;
      const container = termRef.current;
      if (fitAddon && terminal && container) {
        const rect = container.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return;
        try {
          const result = safeFit(fitAddon, terminal);
          if (result) {
            wsSend({ type: "resize", id: sessionId, cols: result.cols, rows: result.rows });
          }
        } catch {}
      }
    }, 50);
  }, [sessionId, wsSend, safeFit]);

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
          if (fitAddonRef.current) {
            const result = safeFit(fitAddonRef.current, terminal);
            if (result) {
              wsSend({ type: "resize", id: sessionId, cols: result.cols, rows: result.rows });
            }
          }
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
    // Native モード時は xterm.js を初期化しない(ペイン枠の中身は Rust が wt.exe / Terminal.app を重ねる)
    if (terminalMode === "native") return;

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
        e.preventDefault();
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

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Clear container before opening (prevents duplicate terminals from StrictMode remounts)
    while (termRef.current.firstChild) {
      termRef.current.removeChild(termRef.current.firstChild);
    }
    terminal.open(termRef.current);

    // GPU 描画(WebGL)で大量ログ出力時のもたつきを解消。DOM レンダラより大幅に速い。
    // WebGL 不可環境(context 喪失含む)では dispose して xterm 既定の DOM レンダラへ自動フォールバック。
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => webglAddon.dispose());
      terminal.loadAddon(webglAddon);
    } catch {
      // WebGL 初期化不可 — DOM レンダラのまま継続(機能は維持、速度のみ既定)
    }

    // Initial fit: retry until container has real dimensions (Grid layout
    // may start at width=0 and expand later, causing cols=1 → vertical text).
    const initialFit = (attempt = 0) => {
      const container = termRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) {
        if (attempt < 20) setTimeout(() => initialFit(attempt + 1), 50);
        return;
      }
      try {
        const result = safeFit(fitAddon, terminal);
        if (result) {
          wsSend({ type: "resize", id: sessionId, cols: result.cols, rows: result.rows });
        }
      } catch {};
    };
    requestAnimationFrame(() => initialFit());

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

    // Alt(Option)+Click: move caret to clicked position by sending arrow keys.
    // Works on Mac (Option) and Win/Linux (Alt) — both map to e.altKey.
    // Listen on document in capture phase so xterm.js internal mouse handlers
    // (which may stopPropagation on .xterm-screen children) can't swallow it.
    // Rendering/font/unicode untouched — this only sends input to PTY.
    const handleAltClick = (e: MouseEvent) => {
      if (!alive) return;
      if (!e.altKey) return;
      if (e.button !== 0) return;
      if (!containerEl?.contains(e.target as Node)) return;
      if (terminal.hasSelection()) return;

      const screen = terminal.element?.querySelector(".xterm-screen") as HTMLElement | null;
      if (!screen) return;
      const rect = screen.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const cellWidth = rect.width / terminal.cols;
      const cellHeight = rect.height / terminal.rows;
      if (cellWidth <= 0 || cellHeight <= 0) return;

      const targetCol = Math.max(
        0,
        Math.min(terminal.cols - 1, Math.floor((e.clientX - rect.left) / cellWidth)),
      );
      const targetRow = Math.max(
        0,
        Math.min(terminal.rows - 1, Math.floor((e.clientY - rect.top) / cellHeight)),
      );

      const buffer = terminal.buffer.active;
      const cursorCol = buffer.cursorX;
      const cursorRow = buffer.cursorY;

      const colDiff = targetCol - cursorCol;
      const rowDiff = targetRow - cursorRow;
      if (colDiff === 0 && rowDiff === 0) return;

      let seq = "";
      if (rowDiff > 0) seq += "\x1b[B".repeat(rowDiff);
      else if (rowDiff < 0) seq += "\x1b[A".repeat(-rowDiff);
      if (colDiff > 0) seq += "\x1b[C".repeat(colDiff);
      else if (colDiff < 0) seq += "\x1b[D".repeat(-colDiff);

      if (seq) {
        e.preventDefault();
        e.stopPropagation();
        wsSend({ type: "write", id: sessionId, data: seq });
      }
    };
    document.addEventListener("mousedown", handleAltClick, true);

    const observer = new ResizeObserver(() => handleResize());
    observer.observe(termRef.current);

    return () => {
      alive = false;
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      observer.disconnect();
      containerEl?.removeEventListener("contextmenu", handleContextMenu, true);
      document.removeEventListener("mousedown", handleAltClick, true);
      onData.dispose();
      unsubscribe();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId, handleResize, wsSend, wsOnMessage, terminalMode]);

  // ────────────────────────────────────────────────────────────────
  // ネイティブ端末オーバーレイ(Preview): Tauri Win/Mac でのみ動作。
  // Rust 側で wt.exe / Terminal.app を起動し、ペイン矩形に常時最前面で重ねる。
  // ────────────────────────────────────────────────────────────────
  const isNativeMode = terminalMode === "native";

  // 矩形変化通知(active=true の時のみ ResizeObserver 等を張る)
  const onRectChange = useCallback(
    (paneId: string, rect: PaneRect) => {
      wsSend({ type: "update_native_terminal_rect", paneId, rect });
    },
    [wsSend],
  );
  useNativeTerminalRect({
    paneRef: rootRef,
    paneId: sessionId,
    active: isNativeMode && isTauri && isVisible,
    onRectChange,
  });

  // 可視状態の切替(タブ切替・detach 時にネイティブ端末も hide/show)
  useEffect(() => {
    if (!isNativeMode || !isTauri) return;
    wsSend({ type: "set_native_terminal_visible", paneId: sessionId, visible: isVisible });
  }, [isNativeMode, isVisible, sessionId, wsSend]);

  // 起動・終了(マウント時に spawn、アンマウント時に close)
  useEffect(() => {
    if (!isNativeMode || !isTauri) return;
    const root = rootRef.current;
    if (!root) return;
    const r = root.getBoundingClientRect();
    const initialRect: PaneRect = {
      x: r.left,
      y: r.top,
      width: r.width,
      height: r.height,
      scaleFactor: window.devicePixelRatio || 1,
    };
    wsSend({ type: "spawn_native_terminal", paneId: sessionId, cwd: null, rect: initialRect });
    return () => {
      wsSend({ type: "close_native_terminal", paneId: sessionId });
    };
    // sessionId と isNativeMode が変わったら spawn/close をやり直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNativeMode, sessionId]);

  return (
    <div
      ref={rootRef}
      data-session-id={sessionId}
      className={`flex flex-col bg-bg min-h-0 min-w-0 h-full w-full relative overflow-hidden ${dragOver ? "ring-2 ring-accent ring-inset" : ""}`}
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
      {/* xterm モード: xterm.js の DOM。Native モードでは中身を空のまま
          (Rust が wt.exe / Terminal.app を重ねるので透過させる) */}
      {terminalMode === "xterm" ? (
        <div ref={termRef} className="flex-1 min-h-0 min-w-0 overflow-hidden" />
      ) : (
        <div
          ref={termRef}
          className="flex-1 min-h-0 min-w-0 overflow-hidden flex items-center justify-center text-text-muted text-xs select-none"
          // ネイティブ端末がオーバーレイされるまでの空き枠(Preview バッジ表示)
        >
          <div className="text-center">
            <div className="text-accent text-xs mb-1">⚡ Native Terminal (Preview)</div>
            <div className="text-text-muted text-[10px]">
              {isTauri
                ? "OS 純正ターミナルをこの枠に重ねます…"
                : "このモードは Tauri デスクトップ版のみ対応"}
            </div>
          </div>
        </div>
      )}
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
