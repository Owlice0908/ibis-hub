import { useState, useCallback, useEffect, useRef } from "react";
import "./App.css";
import logoUrl from "./assets/logo.png";
import Sidebar from "./components/Sidebar";
import TerminalGrid from "./components/TerminalGrid";
import { useWS } from "./useWebSocket";
import { useTauriTransport } from "./useTauriTransport";
import type { Session, LayoutMode, ThemeMode } from "./types";

// Detect Tauri at module level (constant, safe for hooks)
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// In dev mode (Vite), connect to the server port. In production, use same host.
const WS_URL = window.location.port === "1420"
  ? `ws://${window.location.hostname}:9100`
  : `ws://${window.location.host}`;

// Transport hook selected once at module load (safe: isTauri never changes)
const useTransport = isTauri
  ? () => useTauriTransport()
  : () => useWS(WS_URL);

function App() {
  const { send, onMessage, connected } = useTransport();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionIds, setActiveSessionIds] = useState<string[]>([]);
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const [layout, setLayout] = useState<LayoutMode>("single");
  const [questionSessions, setQuestionSessions] = useState<Set<string>>(new Set());
  const [theme, setTheme] = useState<ThemeMode>(() =>
    (localStorage.getItem("ibis-theme") as ThemeMode) || "dark"
  );
  const sessionCountRef = useRef(0);
  const focusedSessionIdRef = useRef<string | null>(null);

  // Keep ref in sync for use in message handler (avoids stale closure)
  focusedSessionIdRef.current = focusedSessionId;

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("ibis-theme", theme);
  }, [theme]);

  // Tauri-only: auto-update check + native drag-and-drop
  useEffect(() => {
    if (!isTauri) return;
    let dragDropUnlisten: (() => void) | null = null;

    (async () => {
      // Auto-update check
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const { ask } = await import("@tauri-apps/plugin-dialog");
        const update = await check();
        if (update) {
          const yes = await ask(`新しいバージョン ${update.version} があります。アップデートしますか？`, {
            title: "Ibis Hub アップデート",
            kind: "info",
          });
          if (yes) {
            await update.downloadAndInstall();
          }
        }
      } catch (e) {
        console.error("Update check failed:", e);
      }

      // Native drag-and-drop: Tauri provides file paths directly
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        dragDropUnlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "drop" && event.payload.paths.length > 0) {
            const sid = focusedSessionIdRef.current;
            if (sid) {
              const data = event.payload.paths
                .map((p: string) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
                .join(" ");
              send({ type: "write", id: sid, data: data + " " });
            }
          }
        });
      } catch (e) {
        console.error("Drag-drop setup failed:", e);
      }
    })();

    return () => {
      if (dragDropUnlisten) dragDropUnlisten();
    };
  }, [send]);

  // Request session list on (re)connect to restore state
  useEffect(() => {
    if (connected) {
      send({ type: "list_sessions" });
    }
  }, [connected, send]);

  // Handle messages from server
  useEffect(() => {
    return onMessage((msg: any) => {
      switch (msg.type) {
        case "session_list":
          // Restore sessions from server (after refresh / reconnect)
          if (msg.sessions && msg.sessions.length > 0) {
            setSessions((prev) => {
              const existingIds = new Set(prev.map((s) => s.id));
              const newSessions = msg.sessions.filter((s: Session) => !existingIds.has(s.id));
              return newSessions.length > 0 ? [...prev, ...newSessions] : prev;
            });
            setActiveSessionIds((prev) => {
              const existing = new Set(prev);
              const newIds = msg.sessions
                .map((s: Session) => s.id)
                .filter((id: string) => !existing.has(id));
              return newIds.length > 0 ? [...prev, ...newIds] : prev;
            });
            setFocusedSessionId((prev) => prev ?? msg.sessions[0]?.id ?? null);
            // Attach to each session to receive PTY output
            for (const s of msg.sessions) {
              send({ type: "attach_session", id: s.id });
            }
          }
          break;
        case "session_created":
          // Deduplicate: don't add if session already exists
          setSessions((prev) => {
            if (prev.some((s) => s.id === msg.session.id)) return prev;
            return [...prev, msg.session];
          });
          setActiveSessionIds((prev) => {
            if (prev.includes(msg.session.id)) return prev;
            return [...prev, msg.session.id];
          });
          setFocusedSessionId(msg.session.id);
          break;
        case "session_question":
          setQuestionSessions((prev) => {
            const next = new Set(prev);
            next.add(msg.id);
            return next;
          });
          break;
        case "session_exited":
          // Session ended naturally (e.g. user typed 'exit') — update status
          setSessions((prev) =>
            prev.map((s) => (s.id === msg.id ? { ...s, status: "exited" } : s))
          );
          break;
        case "session_closed":
          setSessions((prev) => prev.filter((s) => s.id !== msg.id));
          setActiveSessionIds((prev) => prev.filter((sid) => sid !== msg.id));
          setFocusedSessionId((prev) => (prev === msg.id ? null : prev));
          setQuestionSessions((prev) => {
            const next = new Set(prev);
            next.delete(msg.id);
            return next;
          });
          break;
        case "session_renamed":
          setSessions((prev) =>
            prev.map((s) => (s.id === msg.id ? { ...s, name: msg.name } : s))
          );
          break;
        case "session_error":
          alert(msg.error);
          break;
        case "files_picked":
          // Send picked file paths to focused session (use ref to avoid stale closure)
          if (Array.isArray(msg.paths) && msg.paths.length > 0 && focusedSessionIdRef.current) {
            const data = msg.paths.map((p: string) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(" ");
            send({ type: "write", id: focusedSessionIdRef.current, data: data + " " });
          }
          break;
      }
    });
  }, [onMessage, send]);

  const createSession = useCallback((type: "claude" | "shell" = "claude") => {
    sessionCountRef.current += 1;
    send({
      type: "create_session",
      name: type === "claude" ? `Claude ${sessionCountRef.current}` : `Terminal ${sessionCountRef.current}`,
      session_type: type,
    });
  }, [send]);

  const closeSession = useCallback((id: string) => {
    send({ type: "close_session", id });
  }, [send]);

  const selectSession = useCallback((id: string) => {
    setQuestionSessions((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setFocusedSessionId(id);
    setActiveSessionIds((prev) => {
      if (prev.includes(id)) return prev;
      return [...prev, id];
    });
  }, []);

  const removeFromGrid = useCallback((id: string) => {
    setActiveSessionIds((prev) => prev.filter((sid) => sid !== id));
  }, []);

  const renameSession = useCallback((id: string, name: string) => {
    send({ type: "rename_session", id, name });
  }, [send]);

  const visibleSessionIds =
    layout === "single" && focusedSessionId
      ? [focusedSessionId]
      : activeSessionIds;

  const focusedId = layout === "focus" ? focusedSessionId : null;

  return (
    <div className="flex h-screen bg-bg">
      <Sidebar
        sessions={sessions}
        activeSessionIds={activeSessionIds}
        focusedSessionId={focusedSessionId}
        layout={layout}
        theme={theme}
        questionSessionIds={Array.from(questionSessions)}
        onLayoutChange={setLayout}
        onThemeChange={setTheme}
        onCreateSession={createSession}
        onSelectSession={selectSession}
        onCloseSession={closeSession}
        onRenameSession={renameSession}
      />
      <main className="flex-1 flex flex-col min-w-0">
        {visibleSessionIds.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="flex items-center justify-center gap-4 mb-3">
                <img src={logoUrl} alt="Ibis Hub" className={`h-14 w-auto ${theme === "dark" ? "invert brightness-200" : ""}`} />
                <h2 className="text-5xl font-semibold text-text leading-none">
                  Ibis Hub
                </h2>
              </div>
              <p className="text-text-muted mb-1">
                Claude Code session manager
              </p>
              <p className={`text-xs mb-6 ${connected ? "text-success" : "text-danger"}`}>
                {connected ? "Connected" : "Connecting..."}
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => createSession("claude")}
                  className="px-6 py-3 bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors font-medium"
                >
                  + Claude
                </button>
                <button
                  onClick={() => createSession("shell")}
                  className="px-6 py-3 bg-surface-hover hover:bg-border text-text rounded-lg transition-colors font-medium border border-border"
                >
                  + Terminal
                </button>
              </div>
            </div>
          </div>
        ) : (
          <TerminalGrid
            sessions={sessions}
            allSessionIds={activeSessionIds}
            visibleSessionIds={visibleSessionIds}
            layout={layout}
            theme={theme}
            focusedId={focusedId}
            wsSend={send}
            wsOnMessage={onMessage}
            onRemoveFromGrid={removeFromGrid}
            onCloseSession={closeSession}
          />
        )}
      </main>
    </div>
  );
}

export default App;
