import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

interface TerminalPaneProps {
  sessionId: string;
  showControls: boolean;
  onDetach: () => void;
  onClose: () => void;
}

export default function TerminalPane({
  sessionId,
  showControls,
  onDetach,
  onClose,
}: TerminalPaneProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const handleResize = useCallback(() => {
    const fitAddon = fitAddonRef.current;
    const terminal = terminalRef.current;
    if (fitAddon && terminal) {
      try {
        fitAddon.fit();
        invoke("resize_session", {
          id: sessionId,
          cols: terminal.cols,
          rows: terminal.rows,
        }).catch(() => {});
      } catch {
        // ignore fit errors during mount/unmount
      }
    }
  }, [sessionId]);

  useEffect(() => {
    if (!termRef.current) return;

    const terminal = new Terminal({
      theme: {
        background: "#0f0f0f",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
        selectionBackground: "#6366f150",
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
      },
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    terminal.open(termRef.current);

    // Delay initial fit to ensure DOM is ready
    requestAnimationFrame(() => {
      fitAddon.fit();
      invoke("resize_session", {
        id: sessionId,
        cols: terminal.cols,
        rows: terminal.rows,
      }).catch(() => {});
    });

    // Listen for PTY output
    const unlistenOutput = listen<string>(
      `pty-output-${sessionId}`,
      (event) => {
        terminal.write(event.payload);
      }
    );

    // Listen for session exit
    const unlistenExit = listen(`session-exited-${sessionId}`, () => {
      terminal.write("\r\n\x1b[90m[Session ended]\x1b[0m\r\n");
    });

    // Send input to PTY
    const onData = terminal.onData((data) => {
      invoke("write_to_session", { id: sessionId, data }).catch(() => {});
    });

    // Resize observer
    const observer = new ResizeObserver(() => handleResize());
    observer.observe(termRef.current);

    return () => {
      observer.disconnect();
      onData.dispose();
      unlistenOutput.then((fn) => fn());
      unlistenExit.then((fn) => fn());
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId, handleResize]);

  return (
    <div className="flex flex-col bg-bg min-h-0">
      {showControls && (
        <div className="flex items-center justify-end gap-1 px-2 py-1 bg-surface border-b border-border">
          <button
            onClick={onDetach}
            className="text-xs text-text-muted hover:text-text px-1.5 py-0.5 rounded hover:bg-surface-hover transition-colors"
            title="Detach from grid"
          >
            ⊟
          </button>
          <button
            onClick={onClose}
            className="text-xs text-text-muted hover:text-danger px-1.5 py-0.5 rounded hover:bg-surface-hover transition-colors"
            title="Close session"
          >
            ✕
          </button>
        </div>
      )}
      <div ref={termRef} className="flex-1 min-h-0" />
    </div>
  );
}
