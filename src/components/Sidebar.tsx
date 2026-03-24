import type { Session, LayoutMode } from "../types";

interface SidebarProps {
  sessions: Session[];
  activeSessionIds: string[];
  layout: LayoutMode;
  onLayoutChange: (layout: LayoutMode) => void;
  onCreateSession: () => void;
  onSelectSession: (id: string) => void;
  onCloseSession: (id: string) => void;
}

export default function Sidebar({
  sessions,
  activeSessionIds,
  layout,
  onLayoutChange,
  onCreateSession,
  onSelectSession,
  onCloseSession,
}: SidebarProps) {
  return (
    <aside className="w-56 bg-surface border-r border-border flex flex-col h-full shrink-0">
      {/* Header */}
      <div className="p-4 border-b border-border">
        <h1 className="text-lg font-bold text-text tracking-tight">Ibis Hub</h1>
        <p className="text-xs text-text-muted mt-0.5">Session Manager</p>
      </div>

      {/* Layout toggle */}
      <div className="px-3 py-2 border-b border-border">
        <div className="flex gap-1 bg-bg rounded-md p-0.5">
          <button
            onClick={() => onLayoutChange("single")}
            className={`flex-1 text-xs py-1.5 rounded transition-colors ${
              layout === "single"
                ? "bg-surface text-text shadow-sm"
                : "text-text-muted hover:text-text"
            }`}
          >
            Single
          </button>
          <button
            onClick={() => onLayoutChange("grid")}
            className={`flex-1 text-xs py-1.5 rounded transition-colors ${
              layout === "grid"
                ? "bg-surface text-text shadow-sm"
                : "text-text-muted hover:text-text"
            }`}
          >
            Grid
          </button>
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
              className={`mx-2 mb-1 px-3 py-2 rounded-md cursor-pointer transition-colors group ${
                activeSessionIds.includes(session.id)
                  ? "bg-accent/15 border border-accent/30"
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
                  <span className="text-sm truncate">{session.name}</span>
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

      {/* New session button */}
      <div className="p-3 border-t border-border">
        <button
          onClick={onCreateSession}
          className="w-full py-2 bg-accent hover:bg-accent-hover text-white text-sm rounded-md transition-colors font-medium"
        >
          + New Session
        </button>
      </div>
    </aside>
  );
}
