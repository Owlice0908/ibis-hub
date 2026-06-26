import { useState, useMemo } from "react";

export interface Conversation {
  id: string;
  title: string;
  subtitle?: string;
  mtime: number;
  sizeBytes: number;
}

interface ConversationPanelProps {
  open: boolean;
  loading: boolean;
  conversations: Conversation[];
  onClose: () => void;
  onOpen: (id: string, title: string) => void;
  onDelete: (ids: string[]) => void;
  onNewChat: () => void;
}

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "たった今";
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  const d = Math.floor(h / 24);
  return `${d}日前`;
}

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

export default function ConversationPanel({
  open,
  loading,
  conversations,
  onClose,
  onOpen,
  onDelete,
  onNewChat,
}: ConversationPanelProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, query]);

  if (!open) return null;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirmDelete = () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(`${ids.length}件の会話をゴミ箱に移します。よろしいですか？\n（完全削除ではないので後で戻せます）`)) return;
    onDelete(ids);
    setSelected(new Set());
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-border rounded-lg shadow-xl w-[640px] max-w-[92vw] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-base font-bold text-text flex items-center gap-2">
            チャットを始める
          </h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text text-sm px-2 py-1 rounded hover:bg-surface-hover"
          >
            ✕
          </button>
        </div>

        {/* New chat — always first, the user's "新規を一番上に" idea */}
        <div className="px-4 pt-3 pb-1">
          <button
            onClick={onNewChat}
            className="w-full py-2.5 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-md transition-colors flex items-center justify-center gap-2"
          >
            ✨ 新しいチャットを始める
          </button>
        </div>

        <div className="px-4 pt-2 pb-1 text-xs text-text-muted">
          または過去のチャットから選ぶ{" "}
          <span className="text-text-muted/70">
            {loading ? "（読み込み中…）" : `（${conversations.length}件）`}
          </span>
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-border">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="タイトルで検索…"
            className="w-full text-sm bg-bg border border-border rounded px-2 py-1.5 outline-none focus:border-accent"
          />
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto py-1">
          {loading ? (
            <p className="text-sm text-text-muted px-4 py-8 text-center">読み込み中…</p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-text-muted px-4 py-8 text-center">
              {conversations.length === 0 ? "過去のチャットはありません" : "一致する会話がありません"}
            </p>
          ) : (
            filtered.map((c) => (
              <div
                key={c.id}
                className={`mx-2 my-0.5 px-3 py-2 rounded-md flex items-center gap-3 group ${
                  selected.has(c.id) ? "bg-accent/15 border border-accent/40" : "hover:bg-surface-hover border border-transparent"
                }`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(c.id)}
                  onChange={() => toggle(c.id)}
                  className="shrink-0 w-4 h-4 accent-accent cursor-pointer"
                  onClick={(e) => e.stopPropagation()}
                />
                <button
                  className="flex-1 min-w-0 text-left"
                  onClick={() => onOpen(c.id, c.title)}
                  title="クリックでこの会話を開く"
                >
                  <div className="text-[14px] text-text truncate">{c.title}</div>
                  {c.subtitle ? (
                    <div className="text-xs text-text-muted/80 truncate mt-0.5">{c.subtitle}</div>
                  ) : null}
                  <div className="text-xs text-text-muted mt-0.5">
                    {relTime(c.mtime)} · {sizeLabel(c.sizeBytes)}
                  </div>
                </button>
                <button
                  onClick={() => onOpen(c.id, c.title)}
                  className="opacity-0 group-hover:opacity-100 text-xs px-2 py-1 rounded bg-accent/80 hover:bg-accent text-white shrink-0 transition-opacity"
                >
                  開く
                </button>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border flex items-center justify-between">
          <span className="text-xs text-text-muted">
            {selected.size > 0 ? `${selected.size}件選択中` : "行をクリックで開く・チェックで複数選択"}
          </span>
          <button
            onClick={confirmDelete}
            disabled={selected.size === 0}
            className={`text-sm px-3 py-1.5 rounded-md transition-colors ${
              selected.size === 0
                ? "bg-surface-hover text-text-muted cursor-not-allowed"
                : "bg-danger/90 hover:bg-danger text-white"
            }`}
          >
            🗑 選択を削除
          </button>
        </div>
      </div>
    </div>
  );
}
