import { useState, useCallback, useEffect, useRef } from "react";
import "./App.css";
import logoUrl from "./assets/logo.png";
import Sidebar from "./components/Sidebar";
import SplashScreen from "./components/SplashScreen";
import TerminalGrid from "./components/TerminalGrid";
import { useWS } from "./useWebSocket";
import { useTauriTransport } from "./useTauriTransport";
import { findDropTargetSession, pathsToShellArgs } from "./lib/terminalUtils";
import {
  detectInitialPlatform,
  refinePlatformFromTauri,
  isNativeTerminalAvailable,
  resolveTerminalMode,
} from "./lib/environmentUtils";
import type { Session, LayoutMode, ThemeMode, TerminalMode, PlatformInfo } from "./types";

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
// preview.9 で Tauri Win も useTauriTransport に戻す(本筋復帰):
//   - pty_manager.rs に WSLENV + --cd ~ + bash -l -c 修正を入れた
//   - portable-pty を 0.8.1 にダウングレード(0.9 の Windows 読み出し回帰回避)
//   - これで wsl 経由の claude が portable-pty / ConPTY で動く想定
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
  const [showSplash, setShowSplash] = useState(true);
  // 環境判定: 起動時は navigator ベース、Tauri なら get_platform() で確定
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo>(() => detectInitialPlatform());
  const nativeAvailable = isNativeTerminalAvailable(platformInfo);
  const sessionCountRef = useRef(0);
  const focusedSessionIdRef = useRef<string | null>(null);

  // Tauri 経由で正確な OS を取得して platformInfo を確定する
  useEffect(() => {
    if (!isTauri) return;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const plat = await invoke<string>("get_platform");
        setPlatformInfo((prev) => refinePlatformFromTauri(prev, plat));
      } catch (e) {
        console.error("get_platform failed:", e);
      }
    })();
  }, []);

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
        case "session_created": {
          // 受信モードを環境で解決(ブラウザ版で "native" が来ても xterm に降格)
          const { mode: effectiveMode } = resolveTerminalMode(
            msg.session.terminalMode,
            platformInfo,
          );
          const sessionWithMode: Session = { ...msg.session, terminalMode: effectiveMode };
          // Deduplicate: don't add if session already exists
          setSessions((prev) => {
            if (prev.some((s) => s.id === sessionWithMode.id)) return prev;
            return [...prev, sessionWithMode];
          });
          setActiveSessionIds((prev) => {
            if (prev.includes(sessionWithMode.id)) return prev;
            return [...prev, sessionWithMode.id];
          });
          setFocusedSessionId(sessionWithMode.id);
          break;
        }
        case "native_terminal_error": {
          // ネイティブ起動に失敗。該当セッションを xterm モードに降格
          setSessions((prev) =>
            prev.map((s) =>
              s.id === msg.paneId ? { ...s, terminalMode: "xterm" as TerminalMode } : s,
            ),
          );
          console.warn(`Native terminal failed for ${msg.paneId}: ${msg.error}. Fell back to xterm.`);
          break;
        }
        case "native_terminal_exited": {
          // ユーザーが wt/Terminal.app を直接閉じた → セッション自体も閉じる
          setSessions((prev) => prev.filter((s) => s.id !== msg.paneId));
          setActiveSessionIds((prev) => prev.filter((sid) => sid !== msg.paneId));
          setFocusedSessionId((prev) => (prev === msg.paneId ? null : prev));
          break;
        }
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
  }, [onMessage, send]);

  const createSession = useCallback(
    (type: "claude" | "shell" = "claude", terminalMode?: TerminalMode) => {
      sessionCountRef.current += 1;
      const baseName =
        type === "claude" ? `Claude ${sessionCountRef.current}` : `Terminal ${sessionCountRef.current}`;
      // 全環境で xterm モードがデフォルト。
      // Tauri Win では pty_manager.rs が wsl.exe を spawn してブラウザ版と同等の挙動を実現する。
      // Native overlay モード(wt.exe を重ねる方式)は試作コードとして残しているが、
      // デフォルトでは使用しない(明示的に terminalMode="native" を渡した場合のみ)。
      const effectiveMode: TerminalMode = terminalMode ?? "xterm";
      send({
        type: "create_session",
        name: baseName,
        session_type: type,
        terminalMode: effectiveMode,
      });
    },
    [send],
  );

  const closeSession = useCallback((id: string) => {
    // Native セッションは PTY を持たないため、close_session(PtyManager 経路)を呼ぶと
    // "Session not found" alert が出る。terminalMode で分岐して正しい経路に流す。
    const session = sessions.find((s) => s.id === id);
    if (session?.terminalMode === "native") {
      send({ type: "close_native_terminal", paneId: id });
      // Native は session_closed イベントを返さないので、Frontend state を手動でクリーンアップ
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setActiveSessionIds((prev) => prev.filter((sid) => sid !== id));
      setFocusedSessionId((prev) => (prev === id ? null : prev));
      setQuestionSessions((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } else {
      send({ type: "close_session", id });
    }
  }, [send, sessions]);

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
      {showSplash && <SplashScreen onDone={() => setShowSplash(false)} />}
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
