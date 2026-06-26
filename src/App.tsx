import { useState, useCallback, useEffect, useRef } from "react";
import "./App.css";
import logoUrl from "./assets/logo.png";
import Sidebar from "./components/Sidebar";
import SplashScreen from "./components/SplashScreen";
import TerminalGrid from "./components/TerminalGrid";
import ConversationPanel, { type Conversation } from "./components/ConversationPanel";
import { useWS } from "./useWebSocket";
import { useTauriTransport } from "./useTauriTransport";
import { findDropTargetSession, pathsToShellArgs } from "./lib/terminalUtils";
import { ensureNotifyPermission, notifyAttention } from "./lib/notify";
import type { Session, LayoutMode, ThemeMode } from "./types";

// Detect Tauri at module level (constant, safe for hooks)
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
// Detect Mac for D&D coordinate handling (wry returns logical points on macOS,
// physical pixels on Win/Linux — see findDropTargetSession docs).
const IS_MAC = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");

// In dev mode (Vite), connect to the server port. In production, use same host.
const WS_URL = window.location.port === "1420"
  ? `ws://${window.location.hostname}:9100`
  : `ws://${window.location.host}`;

// Transport hook selected once at module load (safe: isTauri never changes)
const useTransport = isTauri
  ? () => useTauriTransport()
  : () => useWS(WS_URL);

// User's preferred session order (set by drag-reordering in the sidebar),
// persisted so the list keeps its order across reloads/reconnects.
const ORDER_KEY = "ibis-session-order";
const loadSessionOrder = (): string[] => {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
};
const saveSessionOrder = (ids: string[]) => {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(ids)); } catch {}
};
// Sort by the saved order; ids not in the saved list keep their relative order
// at the end (new sessions appear after the ones you've already arranged).
const applySavedOrder = <T,>(arr: T[], getId: (item: T) => string): T[] => {
  const order = loadSessionOrder();
  if (order.length === 0) return arr;
  const rank = new Map(order.map((id, i) => [id, i]));
  return arr
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const ra = rank.get(getId(a.item)) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(getId(b.item)) ?? Number.MAX_SAFE_INTEGER;
      return ra === rb ? a.i - b.i : ra - rb;
    })
    .map((x) => x.item);
};

function App() {
  const { send, onMessage, connected } = useTransport();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionIds, setActiveSessionIds] = useState<string[]>([]);
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  // Restore the last-used layout (single/focus/grid) so the app reopens looking
  // the way you left it, instead of always snapping back to single.
  const [layout, setLayout] = useState<LayoutMode>(() => {
    const saved = localStorage.getItem("ibis-layout");
    return saved === "single" || saved === "focus" || saved === "grid"
      ? saved
      : "single";
  });
  const [gridResetSignal, setGridResetSignal] = useState(0);
  const [questionSessions, setQuestionSessions] = useState<Set<string>>(new Set());
  const [theme, setTheme] = useState<ThemeMode>(() =>
    (localStorage.getItem("ibis-theme") as ThemeMode) || "dark"
  );
  const [showSplash, setShowSplash] = useState(true);
  const [showConversations, setShowConversations] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const sessionCountRef = useRef(0);
  const focusedSessionIdRef = useRef<string | null>(null);
  const sessionsRef = useRef<Session[]>([]);

  // Keep refs in sync for use in message handlers (avoids stale closures)
  focusedSessionIdRef.current = focusedSessionId;
  sessionsRef.current = sessions;

  // A session wants attention (asked a y/n question, or rang the bell when it
  // finished). Flag it and — if it isn't the one you're looking at — ping you
  // with a desktop notification + chime so you can run several at once.
  const flagAttention = useCallback((id: string) => {
    setQuestionSessions((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    const isForeground = id === focusedSessionIdRef.current && !document.hidden;
    if (!isForeground) {
      const name = sessionsRef.current.find((s) => s.id === id)?.name || "セッション";
      notifyAttention("Ibis Hub", `${name} があなたを待っています`);
    }
  }, []);

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("ibis-theme", theme);
  }, [theme]);

  // Remember the layout across restarts.
  useEffect(() => {
    localStorage.setItem("ibis-layout", layout);
  }, [layout]);

  // Tauri-only: auto-update check + native drag-and-drop
  useEffect(() => {
    if (!isTauri) return;
    let dragDropUnlisten: (() => void) | null = null;

    (async () => {
      // Auto-update disabled (2026-04-14): popup appeared but updates were
      // not actually applied. Manual DMG install is more reliable.
      // To re-enable, uncomment the block below.
      /*
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
      */

      // Native drag-and-drop: Tauri provides file paths directly
      // Uses position-based targeting to find the correct session pane
      const { invoke } = await import("@tauri-apps/api/core");
      const dlog = (msg: string) => {
        invoke("log_frontend", { message: `dnd: ${msg}` }).catch(() => {});
      };
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        dlog("registering onDragDropEvent listener");
        dragDropUnlisten = await getCurrentWebview().onDragDropEvent((event) => {
          const { type } = event.payload;
          const scale = window.devicePixelRatio || 1;

          if (type === "drop") {
            const paths = event.payload.paths || [];
            const pos = event.payload.position;
            dlog(`drop: paths=${paths.length}, pos=${pos ? `${pos.x},${pos.y}` : "null"}, scale=${scale}`);
            window.dispatchEvent(new CustomEvent("ibis-native-drop"));

            if (paths.length > 0) {
              // Use unit-tested helper to find the target session by drop position
              const sid = findDropTargetSession(
                pos,
                scale,
                document,
                focusedSessionIdRef.current,
                IS_MAC,
              );
              dlog(`drop target: sid=${sid}, isMac=${IS_MAC}`);

              if (sid) {
                send({ type: "write", id: sid, data: pathsToShellArgs(paths) });
              } else {
                dlog("drop: no target session");
              }
            }
          } else if (type === "enter") {
            dlog(`enter: paths=${event.payload.paths?.length || 0}`);
            const pos = event.payload.position;
            if (pos) {
              window.dispatchEvent(new CustomEvent("ibis-native-dragover", { detail: pos }));
            }
          } else if (type === "over") {
            const pos = event.payload.position;
            if (pos) {
              window.dispatchEvent(new CustomEvent("ibis-native-dragover", { detail: pos }));
            }
          } else if (type === "leave") {
            dlog("leave");
            window.dispatchEvent(new CustomEvent("ibis-native-dragleave"));
          }
        });
        dlog("onDragDropEvent listener registered OK");
      } catch (e) {
        dlog(`setup failed: ${e}`);
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
              const merged = newSessions.length > 0 ? [...prev, ...newSessions] : prev;
              return applySavedOrder(merged, (s) => s.id);
            });
            setActiveSessionIds((prev) => {
              const existing = new Set(prev);
              const newIds = msg.sessions
                .map((s: Session) => s.id)
                .filter((id: string) => !existing.has(id));
              const merged = newIds.length > 0 ? [...prev, ...newIds] : prev;
              return applySavedOrder(merged, (id) => id);
            });
            setFocusedSessionId((prev) => prev ?? msg.sessions[0]?.id ?? null);
            // Attach to each session to receive PTY output
            for (const s of msg.sessions) {
              send({ type: "attach_session", id: s.id });
            }
          }
          break;
        case "conversation_list":
          setConversations(Array.isArray(msg.conversations) ? msg.conversations : []);
          setConversationsLoading(false);
          break;
        case "conversation_deleted":
          setConversations((prev) => prev.filter((c) => c.id !== msg.id));
          break;
        case "conversation_delete_error":
          alert(`削除に失敗しました: ${msg.error || "不明なエラー"}`);
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
          flagAttention(msg.id);
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
        case "files_picked": {
          // Always send to the session that triggered +File (msg.sessionId).
          // Do NOT fall back to focused session — the +File button always
          // belongs to a specific pane, so the target is unambiguous.
          const targetId = msg.sessionId;
          if (Array.isArray(msg.paths) && msg.paths.length > 0 && targetId) {
            send({ type: "write", id: targetId, data: pathsToShellArgs(msg.paths) });
          }
          break;
        }
      }
    });
  }, [onMessage, send, flagAttention]);

  // Tab title badge: show how many sessions are waiting for you.
  useEffect(() => {
    const n = questionSessions.size;
    document.title = n > 0 ? `(${n}) Ibis Hub` : "Ibis Hub";
  }, [questionSessions]);

  // Quick session switching: Cmd/Ctrl+1..9 jumps to the Nth session.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key < "1" || e.key > "9") return;
      const idx = parseInt(e.key, 10) - 1;
      const target = sessionsRef.current[idx];
      if (target) {
        e.preventDefault();
        selectSession(target.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const createSession = useCallback((type: "claude" | "shell" | "chatgpt" = "claude") => {
    // First session creation is a user gesture — a good moment to ask for
    // permission to send desktop notifications.
    ensureNotifyPermission();
    sessionCountRef.current += 1;
    const label = type === "claude" ? "Claude" : type === "chatgpt" ? "ChatGPT" : "Terminal";
    send({
      type: "create_session",
      name: `${label} ${sessionCountRef.current}`,
      session_type: type,
    });
  }, [send]);

  const closeSession = useCallback((id: string) => {
    send({ type: "close_session", id });
  }, [send]);

  // "過去のチャット" panel: list / open / soft-delete saved conversations.
  const openConversationsPanel = useCallback(() => {
    setShowConversations(true);
    setConversationsLoading(true);
    send({ type: "list_conversations" });
  }, [send]);

  const openConversation = useCallback((id: string, title: string) => {
    send({ type: "resume_conversation", id, name: title });
    setShowConversations(false);
  }, [send]);

  const deleteConversations = useCallback((ids: string[]) => {
    // Optimistically remove from the list; the server moves them to trash.
    setConversations((prev) => prev.filter((c) => !ids.includes(c.id)));
    for (const id of ids) send({ type: "delete_conversation", id });
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

  // Drag-reorder in the sidebar: move `fromId` to where `toId` currently sits.
  // Reorders the visible session list (and keeps the grid pane order in sync),
  // then persists the new order so it survives a reload.
  const reorderSessions = useCallback((fromId: string, toId: string) => {
    if (fromId === toId) return;
    const prev = sessionsRef.current;
    const from = prev.findIndex((s) => s.id === fromId);
    const to = prev.findIndex((s) => s.id === toId);
    if (from < 0 || to < 0) return;
    const next = [...prev];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const order = next.map((s) => s.id);
    saveSessionOrder(order);
    setSessions(next);
    const rank = new Map(order.map((id, i) => [id, i]));
    setActiveSessionIds((active) =>
      [...active].sort(
        (a, b) =>
          (rank.get(a) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b) ?? Number.MAX_SAFE_INTEGER),
      ),
    );
  }, []);

  // Grid shows at most GRID_MAX panes at once — beyond that the panes get too
  // small to be useful. Extra sessions stay running (mounted, just not shown in
  // the grid) and can be brought in by reordering them into the first slots.
  const GRID_MAX = 6;
  const visibleSessionIds =
    layout === "single" && focusedSessionId
      ? [focusedSessionId]
      : layout === "grid"
        ? activeSessionIds.slice(0, GRID_MAX)
        : activeSessionIds;

  const focusedId = layout === "focus" ? focusedSessionId : null;

  return (
    <div className="flex h-screen bg-bg">
      {showSplash && <SplashScreen onDone={() => setShowSplash(false)} />}
      <Sidebar
        sessions={sessions}
        activeSessionIds={activeSessionIds}
        focusedSessionId={focusedSessionId}
        layout={layout}
        theme={theme}
        questionSessionIds={Array.from(questionSessions)}
        onLayoutChange={setLayout}
        onResetGrid={() => setGridResetSignal((n) => n + 1)}
        onThemeChange={setTheme}
        onCreateSession={createSession}
        onSelectSession={selectSession}
        onCloseSession={closeSession}
        onRenameSession={renameSession}
        onReorderSessions={reorderSessions}
        onOpenConversations={openConversationsPanel}
      />
      <ConversationPanel
        open={showConversations}
        loading={conversationsLoading}
        conversations={conversations}
        onClose={() => setShowConversations(false)}
        onOpen={openConversation}
        onDelete={deleteConversations}
        onNewChat={() => {
          createSession("claude");
          setShowConversations(false);
        }}
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
                  onClick={() => createSession("chatgpt")}
                  className="px-6 py-3 bg-green-600 hover:bg-green-500 text-white rounded-lg transition-colors font-medium"
                >
                  + ChatGPT
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
            gridResetSignal={gridResetSignal}
            wsSend={send}
            wsOnMessage={onMessage}
            onRemoveFromGrid={removeFromGrid}
            onCloseSession={closeSession}
            onAttention={flagAttention}
          />
        )}
      </main>
    </div>
  );
}

export default App;
