import { useState, useRef, useEffect } from "react";
import type { Session, LayoutMode, ThemeMode, TerminalMode } from "../types";
import logoUrl from "../assets/logo.png";
import NotificationBadge from "./NotificationBadge";

interface SidebarProps {
  sessions: Session[];
  activeSessionIds: string[];
  focusedSessionId: string | null;
  layout: LayoutMode;
  theme: ThemeMode;
  questionSessionIds: string[];
  // Tauri デスクトップ版(Win/Mac)でのみ true。ブラウザ運用では常に false。
  nativeAvailable: boolean;
  onLayoutChange: (layout: LayoutMode) => void;
  onThemeChange: (theme: ThemeMode) => void;
  // terminalMode は Tauri Win/Mac の時のみ "native" 指定可能。未指定 = "xterm"。
  onCreateSession: (type?: "claude" | "shell", terminalMode?: TerminalMode) => void;
  onSelectSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
}

export default function Sidebar({
  sessions,
  activeSessionIds,
  focusedSessionId,
  layout,
  theme,
  questionSessionIds,
  nativeAvailable,
  onLayoutChange,
  onThemeChange,
  onCreateSession,
  onSelectSession,
  onCloseSession,
  onRenameSession,
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  // ネイティブモード選択ポップアップの開閉(対象ボタンの種別を持つ)
  const [modeMenu, setModeMenu] = useState<null | "claude" | "shell">(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  // メニュー外クリックで閉じる
  useEffect(() => {
    if (!modeMenu) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setModeMenu(null);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [modeMenu]);

  const startRename = (session: Session) => {
    setEditingId(session.id);
    setEditValue(session.name);
  };

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      onRenameSession(editingId, editValue.trim());
      setEditingId(null);
    } else {
      setEditingId(null);
    }
  };

  const cancelRename = () => {
    setEditingId(null);
  };

  // + ボタン本体クリック: 既存挙動を完全維持(xterm モードで作成)
  const handlePlusClick = (type: "claude" | "shell") => {
    onCreateSession(type, "xterm");
  };

  // ▾ クリック: モード選択メニューを開く(nativeAvailable=true のみ表示)
  const handleArrowClick = (type: "claude" | "shell") => {
    setModeMenu((prev) => (prev === type ? null : type));
  };

  return (
    <aside className="w-56 bg-surface border-r border-border flex flex-col h-full shrink-0">
      {/* Header */}
      <div className="p-4 border-b border-border flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-text tracking-tight flex items-center gap-1.5">
            <img src={logoUrl} alt="" className={`w-5 h-5 ${theme === "dark" ? "invert brightness-200" : ""}`} />
            Ibis Hub
          </h1>
          <p className="text-xs text-text-muted mt-0.5">Session Manager</p>
        </div>
        <button
          onClick={() => onThemeChange(theme === "dark" ? "light" : "dark")}
          className="text-lg px-1.5 py-0.5 rounded hover:bg-surface-hover"
          title={theme === "dark" ? "Light mode" : "Dark mode"}
        >
          {theme === "dark" ? "☀" : "☾"}
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
              onClick={() => onSelectSession(session.id)}
              className={`mx-2 mb-1 px-3 py-2 rounded-md cursor-pointer group ${
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
                      className="text-[15px] leading-snug truncate flex items-center gap-1"
                      title={session.name}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startRename(session);
                      }}
                    >
                      {session.name}
                      {session.terminalMode === "native" && (
                        <span
                          className="text-[9px] px-1 rounded bg-accent/30 text-accent shrink-0"
                          title="Native Terminal (Preview)"
                        >
                          N
                        </span>
                      )}
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

      {/* New session buttons */}
      <div className="relative">
        {/* モード選択メニュー(nativeAvailable のとき ▾ から開く) */}
        {modeMenu && (
          <div
            ref={menuRef}
            className="absolute bottom-full left-3 right-3 mb-1 bg-surface border border-border rounded-md shadow-lg overflow-hidden z-10"
          >
            <button
              onClick={() => { onCreateSession(modeMenu, "xterm"); setModeMenu(null); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-surface-hover"
            >
              {modeMenu === "claude" ? "+ Claude" : "+ Terminal"}
              <span className="text-xs text-text-muted ml-2">(xterm, 通常)</span>
            </button>
            <button
              onClick={() => { onCreateSession(modeMenu, "native"); setModeMenu(null); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-surface-hover border-t border-border"
            >
              {modeMenu === "claude" ? "+ Claude" : "+ Terminal"}
              <span className="text-xs text-accent ml-2">(Native Terminal · Preview)</span>
            </button>
          </div>
        )}

        <div className="p-3 border-t border-border flex gap-2">
          {/* + Claude(本体クリック=xterm、▾=モード選択) */}
          <div className="flex-1 flex">
            <button
              onClick={() => handlePlusClick("claude")}
              className={`flex-1 py-2 bg-accent hover:bg-accent-hover text-white text-sm rounded-l-md transition-colors font-medium ${nativeAvailable ? "" : "rounded-r-md"}`}
            >
              + Claude
            </button>
            {nativeAvailable && (
              <button
                onClick={() => handleArrowClick("claude")}
                className="px-2 bg-accent hover:bg-accent-hover text-white text-sm rounded-r-md transition-colors font-medium border-l border-white/20"
                title="モード選択(xterm / Native Terminal)"
              >
                ▾
              </button>
            )}
          </div>

          {/* + Terminal(本体クリック=xterm、▾=モード選択) */}
          <div className="flex-1 flex">
            <button
              onClick={() => handlePlusClick("shell")}
              className={`flex-1 py-2 bg-surface-hover hover:bg-border text-text text-sm rounded-l-md transition-colors font-medium border border-border ${nativeAvailable ? "border-r-0" : "rounded-r-md"}`}
            >
              + Terminal
            </button>
            {nativeAvailable && (
              <button
                onClick={() => handleArrowClick("shell")}
                className="px-2 bg-surface-hover hover:bg-border text-text text-sm rounded-r-md transition-colors font-medium border border-border"
                title="モード選択(xterm / Native Terminal)"
              >
                ▾
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
