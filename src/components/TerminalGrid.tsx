import type { LayoutMode } from "../types";
import TerminalPane from "./TerminalPane";

interface TerminalGridProps {
  sessionIds: string[];
  layout: LayoutMode;
  onRemoveFromGrid: (id: string) => void;
  onCloseSession: (id: string) => void;
}

export default function TerminalGrid({
  sessionIds,
  layout,
  onRemoveFromGrid,
  onCloseSession,
}: TerminalGridProps) {
  const gridClass =
    layout === "grid" && sessionIds.length > 1
      ? "grid grid-cols-2 grid-rows-[1fr_1fr]"
      : "grid grid-cols-1 grid-rows-1";

  return (
    <div className={`flex-1 ${gridClass} gap-px bg-border min-h-0`}>
      {sessionIds.map((id) => (
        <TerminalPane
          key={id}
          sessionId={id}
          showControls={sessionIds.length > 1}
          onDetach={() => onRemoveFromGrid(id)}
          onClose={() => onCloseSession(id)}
        />
      ))}
    </div>
  );
}
