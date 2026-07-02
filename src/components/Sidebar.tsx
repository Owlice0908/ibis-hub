import { useState, useRef, useEffect } from "react";
import type { Session, LayoutMode, ThemeMode } from "../types";
import appIconUrl from "../assets/app-icon-bird.png";
import NotificationBadge from "./NotificationBadge";

interface SidebarProps {
  sessions: Session[];
  activeSessionIds: string[];
  focusedSessionId: string | null;
  layout: LayoutMode;
  theme: ThemeMode;
  questionSessionIds: string[];
  onLayoutChange: (layout: LayoutMode) => void;
  onResetGrid: () => void;
  onThemeChange: (theme: ThemeMode) => void;
  onCreateSession: (type?: "claude" | "shell" | "chatgpt") => void;
  onSelectSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onReorderSessions: (fromId: string, toId: string) => void;
  onOpenConversations: () => void;
}

export default function Sidebar({
  sessions,
  activeSessionIds,
  focusedSessionId,
  layout,
  theme,
  questionSessionIds,
  onLayoutChange,
  onResetGrid,
  onThemeChange,
  onCreateSession,
  onSelectSession,
  onCloseSession,
  onRenameSession,
  onReorderSessions,
  onOpenConversations,
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const startRename = (session: Session) => {
    setEditingId(session.id);
    setEditValue(session.name);
  };

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      onRenameSession(editingId, editValue.trim());
      setEditingId(null);
    } else {
      // Empty name — revert to original (cancel rename)
      setEditingId(null);
    }
  };

  const cancelRename = () => {
    setEditingId(null);
  };

  return (
    <aside className="w-56 bg-surface border-r border-border flex flex-col h-full shrink-0">
      {/* Header */}
      <div className="p-4 border-b border-border flex items-center justify-between">
        <div>
          <h1 className="text-lg leading-6 font-bold text-text tracking-tight flex items-center gap-1.5">
            <span className="w-6 h-6 shrink-0 inline-flex items-center justify-center">
              <img
                src={appIconUrl}
                alt=""
                className="w-6 h-6 translate-y-[1px] brightness-110 saturate-125 drop-shadow-[0_0_5px_rgba(245,183,64,0.38)]"
              />
            </span>
            Ibis Hub
          </h1>
          <p className="text-xs text-text-muted mt-0.5">Session Manager · v0.2.72</p>
        </div>
        <button
          onClick={() => onThemeChange(theme === "dark" ? "light" : "dark")}
          className="text-lg px-1.5 py-0.5 rounded hover:bg-surface-hover"
          title={theme === "dark" ? "Light mode" : "Dark mode"}
        >
          {theme === "dark" ? "\u2600" : "\u263E"}
        </button>
      </div>

      {/* Layout toggle */}
      <div className="px-3 py-2 border-b border-border">
        <div className="flex gap-1 bg-bg rounded-md p-0.5">
          {(["single", "focus", "grid"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => onLayoutChange(mode)}
              className={`flex-1 text-xs py-1.5 rounded transition-colors ${
                layout === mode
                  ? "bg-surface text-text shadow-sm"
                  : "text-text-muted hover:text-text"
              }`}
            >
              {mode === "single" ? "Single" : mode === "focus" ? "Focus" : "Grid"}
            </button>
          ))}
        </div>
        {layout === "grid" && (
          <button
            onClick={onResetGrid}
            className="w-full mt-1.5 py-1 text-xs text-text-muted hover:text-text rounded border border-border hover:bg-surface-hover transition-colors"
            title="グリッドの大きさを均等に戻します"
          >
            ⤢ 整理（均等に戻す）
          </button>
        )}
      </div>

      {/* Sessions list */}
      <div className="flex-1 overflow-y-auto py-2">
        {sessions.length === 0 ? (
          <p className="text-xs text-text-muted px-3 py-4 text-center">
            No sessions yet
          </p>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              draggable={editingId !== session.id}
              onClick={() => onSelectSession(session.id)}
              onDragStart={(e) => {
                setDragId(session.id);
                e.dataTransfer.effectAllowed = "move";
                // WebKit (Tauri's WKWebView on macOS) won't START a drag unless
                // some data is set here — without this the drag never fires.
                e.dataTransfer.setData("text/plain", session.id);
              }}
              onDragOver={(e) => {
                if (!dragId || dragId === session.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDropTargetId(session.id);
              }}
              onDragLeave={() => {
                setDropTargetId((cur) => (cur === session.id ? null : cur));
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId && dragId !== session.id) {
                  onReorderSessions(dragId, session.id);
                }
                setDragId(null);
                setDropTargetId(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setDropTargetId(null);
              }}
              className={`mx-2 mb-1 px-3 py-2 rounded-md cursor-pointer group ${
                dropTargetId === session.id ? "border-t-2 border-t-accent" : ""
              } ${dragId === session.id ? "opacity-40" : ""} ${
                focusedSessionId === session.id
                  ? "bg-accent/20 border border-accent/40"
                  : activeSessionIds.includes(session.id)
                    ? "bg-surface-hover border border-border"
                    : "hover:bg-surface-hover border border-transparent"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <div
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      session.status === "running"
                        ? "bg-success"
                        : "bg-text-muted"
                    }`}
                  />
                  {editingId === session.id ? (
                    <input
                      ref={inputRef}
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") cancelRename();
                      }}
                      onBlur={commitRename}
                      onClick={(e) => e.stopPropagation()}
                      className="text-sm bg-bg border border-border rounded px-1 py-0 w-full min-w-0 outline-none focus:border-accent"
                    />
                  ) : (
                    <span
                      className="text-[15px] leading-snug truncate"
                      title={session.name}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startRename(session);
                      }}
                    >
                      {session.name}
                    </span>
                  )}
                  {questionSessionIds.includes(session.id) && (
                    <NotificationBadge />
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseSession(session.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-danger text-xs transition-opacity p-1"
                  title="Close session"
                >
                  ✕
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Lighten: clear all terminals' scrollback to free memory */}
      {sessions.length > 0 && (
        <div className="px-3 pt-2">
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("ibis-clear-all"))}
            className="w-full py-1.5 text-xs text-text-muted hover:text-text rounded-md border border-border hover:bg-surface-hover transition-colors"
            title="全セッションの履歴表示を消してメモリを軽くします（会話自体は消えません）"
          >
            🪶 全部軽くする
          </button>
        </div>
      )}

      {/* Past conversations */}
      <div className="px-3 pt-2">
        <button
          onClick={onOpenConversations}
          className="w-full py-1.5 text-xs text-text-muted hover:text-text rounded-md border border-border hover:bg-surface-hover transition-colors"
          title="保存された過去のチャットを開いたり削除したりできます"
        >
          🕘 過去のチャット
        </button>
      </div>

      {/* New session buttons */}
      <div className="p-3 border-t border-border flex gap-2">
        <button
          onClick={() => onCreateSession("claude")}
          className="flex-1 py-2 bg-accent hover:bg-accent-hover text-white text-sm rounded-md transition-colors font-medium"
        >
          + Claude
        </button>
        <button
          onClick={() => onCreateSession("chatgpt")}
          className="flex-1 py-2 bg-green-600 hover:bg-green-500 text-white text-sm rounded-md transition-colors font-medium"
        >
          + ChatGPT
        </button>
        <button
          onClick={() => onCreateSession("shell")}
          className="flex-1 py-2 bg-surface-hover hover:bg-border text-text text-sm rounded-md transition-colors font-medium border border-border"
        >
          + Terminal
        </button>
      </div>
    </aside>
  );
}
