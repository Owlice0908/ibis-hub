import { useEffect, useRef, useState, type ReactElement } from "react";
import type { LayoutMode, Session, ThemeMode } from "../types";
import TerminalPane from "./TerminalPane";

interface TerminalGridProps {
  sessions: Session[];
  allSessionIds: string[];
  visibleSessionIds: string[];
  layout: LayoutMode;
  theme: ThemeMode;
  focusedId?: string | null;
  /** Bump this number to reset the split layout back to an even balance ("整理"). */
  gridResetSignal?: number;
  wsSend: (msg: any) => void;
  wsOnMessage: (handler: (msg: any) => void) => () => void;
  onRemoveFromGrid: (id: string) => void;
  onCloseSession: (id: string) => void;
  onAttention: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Split-panel ("mosaic") layout.
//
// Instead of a CSS grid (where every pane in a column shares one width), the
// visible panes form a binary SPLIT TREE: each internal node splits its area
// into two children, left/right or top/bottom, at an adjustable ratio. Dragging
// a divider changes ONLY that node's ratio — i.e. only the two panes/subtrees on
// either side of that divider — so each pane can end up a different size.
// ---------------------------------------------------------------------------
type LeafNode = { type: "leaf"; id: string };
type SplitNodeT = {
  type: "split";
  key: string;
  dir: "row" | "col"; // row = side-by-side (vertical divider), col = stacked
  ratio: number; // size of child `a` as a fraction of the split (0..1)
  a: TreeNode;
  b: TreeNode;
};
type TreeNode = LeafNode | SplitNodeT;

const MIN_RATIO = 0.1;

// Split a list of nodes evenly in one direction, as a right-leaning chain of
// binary splits. Each node ends up the same size (ratio = 1/N at each step), and
// every adjacent pair gets its own divider — so the ARRANGEMENT is a simple even
// row/column, but each divider moves independently.
function evenSplit(nodes: TreeNode[], dir: "row" | "col", keyPrefix: string): TreeNode {
  if (nodes.length === 1) return nodes[0];
  return {
    type: "split",
    key: keyPrefix,
    dir,
    ratio: 1 / nodes.length,
    a: nodes[0],
    b: evenSplit(nodes.slice(1), dir, keyPrefix + "_"),
  };
}

// Build a split tree that reproduces the original grid arrangement (row-major:
// cols = ceil(sqrt(n)), filled left-to-right, top-to-bottom — e.g. 6 panes →
// top 3 / bottom 3), while letting every divider be dragged independently.
function buildGrid(ids: string[]): TreeNode {
  const n = ids.length;
  if (n <= 1) return { type: "leaf", id: ids[0] };
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const rowNodes: TreeNode[] = [];
  for (let r = 0; r < rows; r++) {
    const group = ids.slice(r * cols, (r + 1) * cols).map((id): TreeNode => ({ type: "leaf", id }));
    if (group.length > 0) rowNodes.push(evenSplit(group, "row", `row${r}`));
  }
  return evenSplit(rowNodes, "col", "rows");
}

// Return a copy of the tree with the ratio of the node `key` replaced.
function setRatio(node: TreeNode, key: string, ratio: number): TreeNode {
  if (node.type === "leaf") return node;
  if (node.key === key) return { ...node, ratio };
  return { ...node, a: setRatio(node.a, key, ratio), b: setRatio(node.b, key, ratio) };
}

interface SplitProps {
  node: TreeNode;
  renderPane: (id: string) => ReactElement;
  onRatio: (key: string, ratio: number) => void;
}

function Split({ node, renderPane, onRatio }: SplitProps) {
  const ref = useRef<HTMLDivElement>(null);

  if (node.type === "leaf") {
    return <div className="min-h-0 min-w-0 w-full h-full overflow-hidden">{renderPane(node.id)}</div>;
  }

  const isRow = node.dir === "row";

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const size = isRow ? rect.width : rect.height;
    const start = isRow ? rect.left : rect.top;
    if (size <= 0) return;
    const onMove = (ev: PointerEvent) => {
      const pos = (isRow ? ev.clientX : ev.clientY) - start;
      const r = Math.max(MIN_RATIO, Math.min(1 - MIN_RATIO, pos / size));
      onRatio(node.key, r);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = isRow ? "col-resize" : "row-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div ref={ref} className={`flex ${isRow ? "flex-row" : "flex-col"} w-full h-full min-h-0 min-w-0`}>
      <div className="min-h-0 min-w-0 overflow-hidden" style={{ flex: `${node.ratio} 1 0%` }}>
        <Split node={node.a} renderPane={renderPane} onRatio={onRatio} />
      </div>
      <div
        onPointerDown={startDrag}
        className={`shrink-0 bg-border hover:bg-accent transition-colors group relative ${
          isRow ? "w-px cursor-col-resize" : "h-px cursor-row-resize"
        }`}
      >
        {/* Invisible wider hit area so the thin divider is easy to grab */}
        <div
          className={`absolute ${isRow ? "inset-y-0 -left-1 -right-1" : "inset-x-0 -top-1 -bottom-1"}`}
        />
      </div>
      <div className="min-h-0 min-w-0 overflow-hidden" style={{ flex: `${1 - node.ratio} 1 0%` }}>
        <Split node={node.b} renderPane={renderPane} onRatio={onRatio} />
      </div>
    </div>
  );
}

export default function TerminalGrid({
  sessions,
  allSessionIds: rawAllSessionIds,
  visibleSessionIds: rawVisibleSessionIds,
  layout,
  theme,
  focusedId,
  gridResetSignal,
  wsSend,
  wsOnMessage,
  onRemoveFromGrid,
  onCloseSession,
  onAttention,
}: TerminalGridProps) {
  // Deduplicate IDs to prevent rendering multiple TerminalPanes for the same session
  const allSessionIds = [...new Set(rawAllSessionIds)];
  const visibleSessionIds = [...new Set(rawVisibleSessionIds)];
  const visibleCount = visibleSessionIds.length;
  const isSplitGrid = layout === "grid" && visibleCount > 1;

  // The split tree for grid mode. Rebuilt (back to an even balance) whenever the
  // set of visible sessions changes or the user presses "整理".
  const [tree, setTree] = useState<TreeNode>(() => buildGrid(visibleSessionIds));
  const sig = visibleSessionIds.join(",");
  useEffect(() => {
    setTree(buildGrid(visibleSessionIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, gridResetSignal]);

  const renderPane = (id: string) => {
    const session = sessions.find((s) => s.id === id);
    return (
      <TerminalPane
        sessionId={id}
        sessionName={session?.name || "Session"}
        sessionType={session?.session_type}
        showControls={visibleCount > 1}
        isVisible={true}
        theme={theme}
        wsSend={wsSend}
        wsOnMessage={wsOnMessage}
        onDetach={() => onRemoveFromGrid(id)}
        onClose={() => onCloseSession(id)}
        onBell={() => onAttention(id)}
      />
    );
  };

  // Keep non-visible sessions mounted (offscreen) so their output keeps flowing.
  const hiddenPanes = allSessionIds
    .filter((id) => !visibleSessionIds.includes(id))
    .map((id) => {
      const session = sessions.find((s) => s.id === id);
      return (
        <div key={id} style={{ position: "absolute", left: "-9999px", width: "1px", height: "1px", overflow: "hidden" }}>
          <TerminalPane
            sessionId={id}
            sessionName={session?.name || "Session"}
            sessionType={session?.session_type}
            showControls={false}
            isVisible={false}
            theme={theme}
            wsSend={wsSend}
            wsOnMessage={wsOnMessage}
            onDetach={() => onRemoveFromGrid(id)}
            onClose={() => onCloseSession(id)}
            onBell={() => onAttention(id)}
          />
        </div>
      );
    });

  // Focus layout: 70% main + 30% side stack
  if (layout === "focus" && focusedId && visibleCount > 1) {
    const sideIds = visibleSessionIds.filter((id) => id !== focusedId);
    const mainSession = sessions.find((s) => s.id === focusedId);

    return (
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className="min-h-0 min-w-0 overflow-hidden border-r border-border" style={{ flex: "7 1 0%" }}>
          <TerminalPane
            key={focusedId}
            sessionId={focusedId}
            sessionName={mainSession?.name || "Session"}
            sessionType={mainSession?.session_type}
            showControls={false}
            isVisible={true}
            theme={theme}
            wsSend={wsSend}
            wsOnMessage={wsOnMessage}
            onDetach={() => onRemoveFromGrid(focusedId)}
            onClose={() => onCloseSession(focusedId)}
          />
        </div>
        <div className="flex flex-col min-h-0 min-w-0 overflow-hidden border-l border-border" style={{ flex: "3 1 0%" }}>
          {sideIds.map((id) => {
            const session = sessions.find((s) => s.id === id);
            return (
              <div key={id} className="flex-1 min-h-0 min-w-0 overflow-hidden border-b border-border last:border-b-0">
                <TerminalPane
                  sessionId={id}
                  sessionName={session?.name || "Session"}
                  sessionType={session?.session_type}
                  showControls={true}
                  isVisible={true}
                  theme={theme}
                  wsSend={wsSend}
                  wsOnMessage={wsOnMessage}
                  onDetach={() => onRemoveFromGrid(id)}
                  onClose={() => onCloseSession(id)}
                  onBell={() => onAttention(id)}
                />
              </div>
            );
          })}
        </div>
        {hiddenPanes}
      </div>
    );
  }

  // Single session (or single layout): one pane fills the area.
  if (!isSplitGrid) {
    const onlyId = visibleSessionIds[0];
    return (
      <div className="flex-1 min-h-0 overflow-hidden bg-border relative">
        {onlyId && <div className="w-full h-full min-h-0 min-w-0 overflow-hidden">{renderPane(onlyId)}</div>}
        {hiddenPanes}
      </div>
    );
  }

  // Grid mode → resizable split-panel layout.
  return (
    <div className="flex-1 min-h-0 overflow-hidden bg-border relative">
      <Split node={tree} renderPane={renderPane} onRatio={(key, r) => setTree((t) => setRatio(t, key, r))} />
      {hiddenPanes}
    </div>
  );
}
