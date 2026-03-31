import type { LayoutMode, Session, ThemeMode } from "../types";
import TerminalPane from "./TerminalPane";

interface TerminalGridProps {
  sessions: Session[];
  allSessionIds: string[];
  visibleSessionIds: string[];
  layout: LayoutMode;
  theme: ThemeMode;
  focusedId?: string | null;
  wsSend: (msg: any) => void;
  wsOnMessage: (handler: (msg: any) => void) => () => void;
  onRemoveFromGrid: (id: string) => void;
  onCloseSession: (id: string) => void;
}

export default function TerminalGrid({
  sessions,
  allSessionIds: rawAllSessionIds,
  visibleSessionIds: rawVisibleSessionIds,
  layout,
  theme,
  focusedId,
  wsSend,
  wsOnMessage,
  onRemoveFromGrid,
  onCloseSession,
}: TerminalGridProps) {
  // Deduplicate IDs to prevent rendering multiple TerminalPanes for the same session
  const allSessionIds = [...new Set(rawAllSessionIds)];
  const visibleSessionIds = [...new Set(rawVisibleSessionIds)];
  const visibleCount = visibleSessionIds.length;

  // Focus layout: 70% main + 30% side stack
  if (layout === "focus" && focusedId && visibleCount > 1) {
    const sideIds = visibleSessionIds.filter((id) => id !== focusedId);
    const mainSession = sessions.find((s) => s.id === focusedId);

    return (
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Main panel */}
        <div className="min-h-0 min-w-0 overflow-hidden border-r border-border" style={{ flex: "7 1 0%" }}>
          <TerminalPane
            key={focusedId}
            sessionId={focusedId}
            sessionName={mainSession?.name || "Session"}
            showControls={false}
            isVisible={true}
            theme={theme}
            wsSend={wsSend}
            wsOnMessage={wsOnMessage}
            onDetach={() => onRemoveFromGrid(focusedId)}
            onClose={() => onCloseSession(focusedId)}
          />
        </div>
        {/* Side panels */}
        <div className="flex flex-col min-h-0 overflow-hidden border-l border-border" style={{ flex: "3 1 0%" }}>
          {sideIds.map((id) => {
            const session = sessions.find((s) => s.id === id);
            return (
              <div key={id} className="flex-1 min-h-0 overflow-hidden border-b border-border last:border-b-0">
                <TerminalPane
                  sessionId={id}
                  sessionName={session?.name || "Session"}
                  showControls={true}
                  isVisible={true}
                  theme={theme}
                  wsSend={wsSend}
                  wsOnMessage={wsOnMessage}
                  onDetach={() => onRemoveFromGrid(id)}
                  onClose={() => onCloseSession(id)}
                />
              </div>
            );
          })}
        </div>
        {/* Hidden sessions (not in visible list but need to stay mounted) */}
        {allSessionIds.filter((id) => !visibleSessionIds.includes(id)).map((id) => {
          const session = sessions.find((s) => s.id === id);
          return (
            <div key={id} style={{ position: "absolute", left: "-9999px", width: "1px", height: "1px", overflow: "hidden" }}>
              <TerminalPane
                sessionId={id}
                sessionName={session?.name || "Session"}
                showControls={false}
                isVisible={false}
                theme={theme}
                wsSend={wsSend}
                wsOnMessage={wsOnMessage}
                onDetach={() => onRemoveFromGrid(id)}
                onClose={() => onCloseSession(id)}
              />
            </div>
          );
        })}
      </div>
    );
  }

  // Grid / Single layout
  let cols = 1;
  let rows = 1;
  if (layout === "grid" && visibleCount > 1) {
    cols = Math.ceil(Math.sqrt(visibleCount));
    rows = Math.ceil(visibleCount / cols);
  }

  const gridStyle =
    layout === "grid" && visibleCount > 1
      ? {
          display: "grid" as const,
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows: `repeat(${rows}, 1fr)`,
        }
      : {
          display: "grid" as const,
          gridTemplateColumns: "1fr",
          gridTemplateRows: "1fr",
        };

  return (
    <div className="flex-1 gap-px bg-border min-h-0 overflow-hidden" style={gridStyle}>
      {allSessionIds.map((id) => {
        const session = sessions.find((s) => s.id === id);
        const isVisible = visibleSessionIds.includes(id);
        return (
          <div
            key={id}
            className={isVisible ? "min-h-0 min-w-0 overflow-hidden" : ""}
            style={isVisible ? {} : { position: "absolute", left: "-9999px", width: "1px", height: "1px", overflow: "hidden" }}
          >
            <TerminalPane
              sessionId={id}
              sessionName={session?.name || "Session"}
              showControls={visibleCount > 1}
              isVisible={isVisible}
              theme={theme}
              wsSend={wsSend}
              wsOnMessage={wsOnMessage}
              onDetach={() => onRemoveFromGrid(id)}
              onClose={() => onCloseSession(id)}
            />
          </div>
        );
      })}
    </div>
  );
}
