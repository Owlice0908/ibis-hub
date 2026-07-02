import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import type { ThemeMode } from "../types";
import {
  decideKeyAction,
  decideRightClick,
  dndPositionToLogical,
} from "../lib/terminalUtils";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const IS_MAC = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp)$/i;
const FILE_PATH_RE =
  /(?<=^|[\s\(\[{<'"`])((?:\/home\/nakamura\/ibis-hub-shared\/|~\/ibis-hub-shared\/|\/home\/nakamura\/\.codex\/generated_images\/|~\/\.codex\/generated_images\/)[^\s\x00-\x1f<>"|]+\.(?:png|jpe?g|gif|webp|bmp|pdf))/gi;

// Claude Code の Bash run_in_background で起動された task を pty 出力から捕捉。
// 起動時: "Command running in background with ID: <hexish>" が Tool result 内に出る
// 完了時: <task-notification>...<task-id>xxx</task-id>...<status>completed</status>...
//         </task-notification> の user turn が続く行に出る
const TASK_START_RE = /Command running in background with ID:\s*([A-Za-z0-9_-]+)/;
const TASK_DONE_RE =
  /<task-notification>[\s\S]*?<task-id>\s*([A-Za-z0-9_-]+)\s*<\/task-id>[\s\S]*?<status>\s*(?:completed|failed|cancelled)\s*<\/status>/;

// 過去実測の task 実行時間を指数移動平均で保持。全 pane 共有、session_type 別
// に分けないのは「background task の性格が session_type にあまり依存しない」
// ため(ほぼ全部 gh run watch 系)。alpha=0.3 で新しい実測を強めに反映。
const TASK_AVG_KEY = "ibis-task-avg";
function loadTaskAvgMs(): { avgMs: number; count: number } {
  try {
    const raw = localStorage.getItem(TASK_AVG_KEY);
    if (!raw) return { avgMs: 0, count: 0 };
    const parsed = JSON.parse(raw);
    return {
      avgMs: typeof parsed.avgMs === "number" ? parsed.avgMs : 0,
      count: typeof parsed.count === "number" ? parsed.count : 0,
    };
  } catch {
    return { avgMs: 0, count: 0 };
  }
}
function updateTaskAvgMs(durationMs: number) {
  try {
    const prev = loadTaskAvgMs();
    const alpha = prev.count === 0 ? 1 : 0.3;
    const nextAvg = prev.avgMs * (1 - alpha) + durationMs * alpha;
    localStorage.setItem(TASK_AVG_KEY, JSON.stringify({ avgMs: nextAvg, count: prev.count + 1 }));
  } catch {}
}
function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

type ImageAction = {
  url: string;
  path: string;
  fileName: string;
};

// ──────────────────────────────────────────────────────────────────────
// クリップボード書込みヘルパ (2026-06-26 復元、元実装は 7059895):
// - 主経路: hidden textarea + document.execCommand("copy")。permission 不要、
//   user-select:none 環境でも動作、LAN/Tailscale IP 等で navigator.clipboard が
//   使えない場合のフォールバックを兼ねる。
// - 並行: window.isSecureContext + navigator.clipboard.writeText を best-effort
//   で試行。両方走らせて少なくとも片方が成功する設計。
// - staff 取り込み (ddc736e) で消えた修正の復元。
// ──────────────────────────────────────────────────────────────────────
function copyToClipboard(text: string) {
  fallbackCopy(text);
  try {
    if (window.isSecureContext && navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  } catch { /* ignore */ }
}
function fallbackCopy(text: string) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    // App-wide `user-select: none` would block selection inside the textarea
    // and cause execCommand("copy") to copy nothing — force "text" here.
    ta.style.userSelect = "text";
    (ta.style as any).webkitUserSelect = "text";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch { /* leave clipboard unchanged */ }
}

function sharedUrlForGeneratedPath(uri: string) {
  const rel = uri
    .replace(/^\/home\/nakamura\/ibis-hub-shared\//, "")
    .replace(/^~\/ibis-hub-shared\//, "")
    .replace(/^\/home\/nakamura\/\.codex\/generated_images\//, "")
    .replace(/^~\/\.codex\/generated_images\//, "");
  const origin =
    window.location.protocol === "http:" || window.location.protocol === "https:"
      ? window.location.origin
      : "http://127.0.0.1:9100";
  return `${origin}/file?path=${encodeURIComponent(`/home/nakamura/ibis-hub-shared/${rel}`)}`;
}

function fileNameFromPath(path: string) {
  return decodeURIComponent(path.split(/[\\/]/).filter(Boolean).pop() || "generated-image.png");
}

function latestImagePathFromText(text: string) {
  FILE_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let latestImagePath = "";
  while ((match = FILE_PATH_RE.exec(text)) !== null) {
    if (IMAGE_EXT_RE.test(match[1])) latestImagePath = match[1];
  }
  return latestImagePath;
}

function downloadSharedFile(url: string, fileName: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

const DARK_THEME = {
  background: "#0f0f0f",
  foreground: "#e5e5e5",
  cursor: "#e5e5e5",
  selectionBackground: "#6366f1aa",
  black: "#0f0f0f",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#f59e0b",
  blue: "#6366f1",
  magenta: "#a855f7",
  cyan: "#06b6d4",
  white: "#e5e5e5",
  brightBlack: "#555555",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#fbbf24",
  brightBlue: "#818cf8",
  brightMagenta: "#c084fc",
  brightCyan: "#22d3ee",
  brightWhite: "#ffffff",
};

const LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#1a1a1a",
  cursor: "#1a1a1a",
  selectionBackground: "#4f46e5aa",
  black: "#1a1a1a",
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#d97706",
  blue: "#4f46e5",
  magenta: "#9333ea",
  cyan: "#0891b2",
  white: "#f5f5f5",
  brightBlack: "#737373",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#f59e0b",
  brightBlue: "#6366f1",
  brightMagenta: "#a855f7",
  brightCyan: "#06b6d4",
  brightWhite: "#ffffff",
};

interface TerminalPaneProps {
  sessionId: string;
  sessionName: string;
  /** "claude" | "chatgpt" | "terminal" | 他。画像プレビューの発火判定に使う。 */
  sessionType?: string;
  showControls: boolean;
  isVisible: boolean;
  theme: ThemeMode;
  wsSend: (msg: any) => void;
  wsOnMessage: (handler: (msg: any) => void) => () => void;
  onDetach: () => void;
  onClose: () => void;
  /** Called when this session rings the terminal bell or otherwise wants attention. */
  onBell?: () => void;
}

export default function TerminalPane({
  sessionId,
  sessionName,
  sessionType,
  showControls,
  isVisible,
  theme,
  wsSend,
  wsOnMessage,
  onDetach,
  onClose,
  onBell,
}: TerminalPaneProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleRef = useRef(isVisible);
  const bufferedDataRef = useRef("");
  const onBellRef = useRef(onBell);
  onBellRef.current = onBell;
  const [dragOver, setDragOver] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [imageAction, setImageAction] = useState<ImageAction | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  // このセッションで表示した画像の履歴 (新しい順、先頭が最新)。
  // 「やっぱさっきのがいい」等の指示のため直近何枚かのサムネイルを見せる用途。
  // sessionId (= pane 単位) にスコープ、他セッションとは共有しない。
  const [imageHistory, setImageHistory] = useState<ImageAction[]>([]);
  // プレビューの最小化状態。true = 右下にピル型バッジで畳む、false = 通常表示。
  const [previewMinimized, setPreviewMinimized] = useState(false);
  // 上部の画像アクションバー (プレビュー/ダウンロード/パス/✕) の最小化状態。
  // true = 上部バーを畳んで右上に小バッジ表示 (imageAction 自体は保持)
  const [actionBarMinimized, setActionBarMinimized] = useState(false);
  // 「Command running in background with ID: xxx」で始まって
  // <task-notification>...<status>completed</status>...</task-notification> で
  // 終わる background task を捕まえて、pane ヘッダーに経過時間 + 進捗メーターを出す。
  // 過去平均を localStorage で持ち、進行率 = 経過 / 平均 で色分け表示。
  const [activeTask, setActiveTask] = useState<{ id: string; startTime: number } | null>(null);
  const activeTaskRef = useRef<{ id: string; startTime: number } | null>(null);
  activeTaskRef.current = activeTask;
  const [taskElapsedMs, setTaskElapsedMs] = useState(0);
  const dragDepthRef = useRef(0);
  const MAX_UPLOAD_SIZE = 100 * 1024 * 1024; // 100MB
  // Cap buffered output for hidden panes. Kept modest so many idle background
  // sessions don't balloon memory (a cause of the app feeling heavy).
  const MAX_BUFFER_SIZE = 2 * 1024 * 1024; // 2MB max buffer for hidden terminals

  const showImageActionForPath = useCallback((path: string) => {
    if (!path) return;
    const next: ImageAction = {
      url: sharedUrlForGeneratedPath(path),
      path,
      fileName: fileNameFromPath(path),
    };
    setImageAction(next);
    setPreviewFailed(false);
    // 新しい画像が来たら最小化を解除して表示に戻す(ユーザーは新しい生成を見たい)。
    setPreviewMinimized(false);
    // 履歴に追加 (同一 path があれば先頭に押し出し、重複除去)。直近 20 枚まで保持。
    setImageHistory((prev) => {
      const filtered = prev.filter((item) => item.path !== path);
      return [next, ...filtered].slice(0, 20);
    });
  }, []);

  const scanTerminalForLatestImage = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const buffer = terminal.buffer.active;
    const start = Math.max(0, buffer.baseY + buffer.cursorY - 200);
    let text = "";
    for (let i = start; i <= buffer.baseY + buffer.cursorY; i++) {
      text += `${buffer.getLine(i)?.translateToString(true) || ""}\n`;
    }
    showImageActionForPath(latestImagePathFromText(text));
  }, [showImageActionForPath]);

  const loadLatestSharedImage = useCallback(async () => {
    try {
      const res = await fetch("/shared/latest-image.json", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (typeof data?.path === "string") showImageActionForPath(data.path);
    } catch {}
  }, [showImageActionForPath]);

  // Renderer: we use xterm's built-in DOM renderer (no addon). In this app's
  // WKWebView the accelerated renderers (WebGL/Canvas-beta) each broke something
  // — stale rows after scroll, text splitting while selecting, or the box-drawing
  // input frame not drawing — so DOM (always correct) is the right choice. Scroll
  // cost is kept down by the reduced scrollback instead.

  const safeFit = useCallback((fitAddon: FitAddon, terminal: Terminal) => {
    const dims = fitAddon.proposeDimensions();
    if (!dims || isNaN(dims.cols) || isNaN(dims.rows)) return null;
    const cols = Math.max(dims.cols - 1, 20);
    const rows = Math.max(dims.rows, 4);
    terminal.resize(cols, rows);
    return { cols, rows };
  }, []);

  const handleResize = useCallback(() => {
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      const fitAddon = fitAddonRef.current;
      const terminal = terminalRef.current;
      const container = termRef.current;
      if (fitAddon && terminal && container) {
        const rect = container.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return;
        try {
          const result = safeFit(fitAddon, terminal);
          if (result) {
            wsSend({ type: "resize", id: sessionId, cols: result.cols, rows: result.rows });
          }
        } catch {}
      }
    }, 50);
  }, [sessionId, wsSend, safeFit]);

  // Force the inner TUI (Claude / codex) to repaint its whole UI — including the
  // white rounded input frame — by sending a REAL size change (SIGWINCH) and
  // reverting it a moment later. After a reload/restore the frame is often drawn
  // mid-resize and then never redrawn, so it goes missing until the user manually
  // resizes the window. A same-size resize won't trigger a redraw, so we nudge
  // the columns by one and back: brief, barely visible, and reliably repaints.
  const nudgeRedraw = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const { cols, rows } = terminal;
    if (!cols || !rows) return;
    try {
      wsSend({ type: "resize", id: sessionId, cols: Math.max(cols - 1, 2), rows });
      setTimeout(() => {
        wsSend({ type: "resize", id: sessionId, cols, rows });
      }, 120);
    } catch {}
  }, [sessionId, wsSend]);

  // Upload dropped file to server, get path back, send to PTY
  const handleFileDrop = useCallback((files: FileList) => {
    Array.from(files).forEach((file) => {
      if (file.size > MAX_UPLOAD_SIZE) {
        console.warn(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB): ${file.name}`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        wsSend({
          type: "upload_file",
          name: file.name,
          data: base64,
          sessionId,
        });
      };
      reader.readAsDataURL(file);
    });
  }, [wsSend, sessionId]);

  // Tauri-only: native drag-and-drop visual feedback via custom events from App.tsx
  useEffect(() => {
    if (!isTauri) return;
    const root = rootRef.current;
    if (!root) return;

    const handleDragOver = (e: Event) => {
      const { x, y } = (e as CustomEvent).detail;
      const scale = window.devicePixelRatio || 1;
      const rect = root.getBoundingClientRect();
      // Use the same Mac/non-Mac logic as App.tsx via the shared helper.
      const { x: cx, y: cy } = dndPositionToLogical({ x, y }, scale, IS_MAC);
      const isOver = cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom;
      setDragOver(isOver);
    };

    const handleClear = () => setDragOver(false);

    window.addEventListener("ibis-native-dragover", handleDragOver);
    window.addEventListener("ibis-native-dragleave", handleClear);
    window.addEventListener("ibis-native-drop", handleClear);

    return () => {
      window.removeEventListener("ibis-native-dragover", handleDragOver);
      window.removeEventListener("ibis-native-dragleave", handleClear);
      window.removeEventListener("ibis-native-drop", handleClear);
    };
  }, []);

  // 1 秒毎に tick して taskElapsedMs を更新 → メーターが動く。
  // activeTask が null の間は interval を起動しない (無駄 rerender 防止)。
  useEffect(() => {
    if (!activeTask) return;
    const iv = setInterval(() => {
      setTaskElapsedMs(Date.now() - activeTask.startTime);
    }, 1000);
    return () => clearInterval(iv);
  }, [activeTask]);

  // 2026-07-01 v0.2.52: 可視化時は「レイヤー戻すだけ」で描画済みの状態が
  // そのまま見える設計にしたので、refit と refresh と nudgeRedraw は基本不要。
  // scrollToBottom だけ念のため実行し、サイズが変わっている時のみ 1 フレーム
  // 後に fit する (dimensions 変化なしなら safeFit は軽く抜ける)。
  useEffect(() => {
    visibleRef.current = isVisible;
    if (isVisible && terminalRef.current) {
      const terminal = terminalRef.current;
      if (bufferedDataRef.current) {
        terminal.write(bufferedDataRef.current);
        bufferedDataRef.current = "";
      }
      requestAnimationFrame(() => {
        try {
          if (fitAddonRef.current) {
            const result = safeFit(fitAddonRef.current, terminal);
            if (result) {
              wsSend({ type: "resize", id: sessionId, cols: result.cols, rows: result.rows });
            }
          }
        } catch {}
        terminal.scrollToBottom();
      });
    }
  }, [isVisible, nudgeRedraw]);

  // Update terminal theme when theme changes
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = theme === "dark" ? DARK_THEME : LIGHT_THEME;
    }
  }, [theme]);

  useEffect(() => {
    if (!termRef.current) return;

    const terminal = new Terminal({
      theme: theme === "dark" ? DARK_THEME : LIGHT_THEME,
      // PlemolJP Console: a terminal-oriented monospace (IBM Plex based) that
      // covers Latin + Japanese + box-drawing AND — crucially — renders
      // East-Asian-Ambiguous characters (①②③ etc.) as HALFWIDTH. That matches
      // the terminal/CLI treating them as 1 column, so they don't spill into the
      // next cell, while kana/kanji stay a clean 2 columns. Installed via
      // Homebrew (font-plemol-jp); UDEV Gothic/Menlo are metric fallbacks.
      fontFamily: "'PlemolJP Console', 'UDEV Gothic', 'Menlo', monospace",
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: false,
      cursorStyle: "bar",
      // Lighter scrollback (was 1000) → fewer rows for the DOM renderer to keep
      // and repaint, so scrolling stays snappy and memory is lower. Older
      // output beyond this scrolls off; the on-disk scrollback still restores
      // recent context on relaunch.
      scrollback: 500,
      allowProposedApi: true,
      rightClickSelectsWord: false, // We handle right-click ourselves (copy/paste)
      smoothScrollDuration: 0,
      // Default is 1 line per wheel notch, which feels sluggish on Mac
      // trackpads. Move several lines per tick so scrolling feels responsive
      // (hold Alt for the faster step).
      scrollSensitivity: 3,
      fastScrollSensitivity: 8,
    });

    // 2026-07-02 v0.2.67: Claude Code の Alternate Screen Buffer 切替
    // (CSI ? 1049 h/l、および補助の 47/1047/1048) を xterm.js の parser で
    // intercept して無視。Normal Buffer 継続で描画される → xterm scrollback
    // が動く = ホイール/scrollbar でスクロールできる。
    // 副作用: Claude Code の全画面 UI 描画が Normal Buffer に累積するため
    // 過去 scroll した時に描画残骸が見える可能性あり。nakamura「文字の問題も
    // これが原因かもしれない」との仮説の検証も兼ねる。
    try {
      const swallowAlt = (params: any) => {
        const arr = typeof params?.toArray === "function" ? params.toArray() : (Array.isArray(params) ? params : []);
        const p = Array.isArray(arr[0]) ? arr[0][0] : arr[0];
        if (p === 1049 || p === 47 || p === 1047 || p === 1048) return true; // 無視して消化
        return false;
      };
      terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, swallowAlt);
      terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, swallowAlt);
    } catch {}

    // Copy/paste shortcuts (Ctrl+Shift+C/V for Linux/Windows, Cmd+C/V for Mac)
    const isMac = navigator.platform.toLowerCase().includes("mac");
    terminal.attachCustomKeyEventHandler((e) => {
      // Cmd/Ctrl+F: open in-terminal search (search the scrollback).
      if (e.type === "keydown" && (isMac ? e.metaKey : e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setShowSearch(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
        return false;
      }
      // Esc: Claude/codex の中断・キャンセル要求を PTY に流す。
      //   2026-06-26 版は \x1b\x15 (Esc + Ctrl+U) を送って「行クリア強制発火」
      //   を狙っていたが、Ctrl+U が余計に付くと **送信後の応答中断** で
      //   Claude/codex 側の Esc 判定を上書きしてしまい効かないケースがあった
      //   (nakamura 指摘 2026-07-01)。
      //   Esc 単発だと Claude/codex は状況判定して:
      //     - 入力中 → 入力バッファのキャンセル
      //     - 応答生成中 → "Escape to interrupt" → もう一度 Esc で確定中断
      //   が両方効く。余計なバイトを付けない。
      if (
        e.type === "keydown" &&
        e.key === "Escape" &&
        !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey &&
        !e.isComposing
      ) {
        e.preventDefault();
        wsSend({ type: "write", id: sessionId, data: "\x1b" });
        return false;
      }
      // Ctrl+Tab / Ctrl+Shift+Tab: ブラウザ的な「次/前タブ」で Sidebar のセッション
      // を切替。通常ブラウザの Ctrl+Tab 相当。フォーカスされたまま切替できる。
      // Ibis Hub 独自のカスタムイベントで App.tsx に伝達。
      if (
        e.type === "keydown" &&
        e.key === "Tab" &&
        e.ctrlKey &&
        !e.altKey && !e.metaKey && !e.isComposing
      ) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(e.shiftKey ? "ibis-prev-session" : "ibis-next-session"));
        return false;
      }
      // Ctrl+Shift+A: ターミナル内容を全選択 (Bash の Ctrl+A は行頭移動なので競合)。
      // ブラウザの Ctrl+A 相当を Shift 修飾で提供。
      if (
        e.type === "keydown" &&
        e.key === "A" &&
        e.ctrlKey && e.shiftKey &&
        !e.altKey && !e.metaKey && !e.isComposing
      ) {
        e.preventDefault();
        try { terminal.selectAll(); } catch {}
        return false;
      }
      // Shift+Enter → insert a newline instead of submitting. Sends ESC+CR,
      // the same sequence Claude Code's `/terminal-setup` installs; Claude and
      // codex both read it as "newline, don't send". Lets you write multi-line
      // messages without the line firing off on the first Enter.
      if (
        e.type === "keydown" &&
        e.key === "Enter" &&
        e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.isComposing
      ) {
        e.preventDefault();
        wsSend({ type: "write", id: sessionId, data: "\x1b\r" });
        return false;
      }
      // 2026-06-26 復元: claude のマウスモード中は xterm 自身の選択 (getSelection) が
      // 空になる。代わりに Shift+ドラッグで作った OS / DOM 選択 (window.getSelection)
      // が有効選択。両者の OR を effectiveSel として「コピー可能なテキスト」とみなす。
      const xtermSel = terminal.getSelection();
      const domSel = (typeof window !== "undefined" && window.getSelection)
        ? (window.getSelection()?.toString() || "")
        : "";
      const effectiveSel = xtermSel || domSel;

      // Delegate the decision to a pure function so it stays unit-testable.
      // See src/lib/terminalUtils.ts and tests/unit/terminalUtils.test.ts.
      const decision = decideKeyAction(
        {
          type: e.type,
          key: e.key,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          isComposing: e.isComposing,
        },
        isMac,
        !!effectiveSel,
      );

      if (decision === "copy") {
        // execCommand 主経路でコピー。preventDefault でブラウザの native copy が
        // 上書きしないようにする。終わったら xterm/DOM の両選択をクリア。
        e.preventDefault();
        if (effectiveSel) {
          copyToClipboard(effectiveSel);
          terminal.clearSelection();
          window.getSelection()?.removeAllRanges();
        }
        return false;
      }
      if (decision === "paste") {
        // Do NOT paste here. A single Cmd+V produces both this keydown AND a
        // DOM "paste" event on xterm's textarea. If we sent the clipboard here
        // too, the text would arrive twice ("2個ペーストされる"). All pasting is
        // funneled through the single capture-phase "paste" listener below,
        // which sends once and stops xterm's own paste handler from also
        // firing. So just let the keydown pass through.
        return true;
      }
      // Select + Backspace/Delete: delete selected text by sending backspaces.
      // effectiveSel ベースで判定するので Shift+ドラッグ選択でも動く。
      if (e.key === "Backspace" || e.key === "Delete") {
        if (effectiveSel && effectiveSel.length > 0) {
          terminal.clearSelection();
          window.getSelection()?.removeAllRanges();
          const backspaces = "\x7f".repeat(effectiveSel.length);
          wsSend({ type: "write", id: sessionId, data: backspaces });
          return false;
        }
      }
      return true;
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const unicode11Addon = new Unicode11Addon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.loadAddon(unicode11Addon);
    terminal.loadAddon(searchAddon);

    // 2026-06-26 ローカルファイルパスをリンク化:
    //   ChatGPT(codex)が画像を生成して `/home/.../foo.png` のようなパスを
    //   出力した時、xterm 上でクリック可能にする。サーバ側に /file?path= で
    //   ホーム配下のファイル配信エンドポイントを追加してあるので、リンク
    //   クリック時に新タブで開くだけでブラウザがプレビュー表示する。
    // 2026-06-26 security review 反映: .svg / .json / .md / .txt / .csv は外す
    // (SVG XSS リスク、機密ファイル漏洩リスク)。画像 + PDF のみリンク化対象に。
    //
    // lookbehind `(?<=^|[\s\(\[{<'"`])` で URL の path 部分に被らないようにする
    // (例: https://example.com/foo.png の /foo.png は前置文字が 'm' なのでマッチしない)。
    // これがないと WebLinksAddon が処理すべき http URL を奪って /file?path= に振って
    // しまい、クリックすると ibis hub の index.html が開いてしまう挙動になっていた。
    // 2026-06-30 検出範囲を **~/ibis-hub-shared/ 配下** + **~/.codex/generated_images/ 配下**
    // に絞ったので、ANSI 1;2c 系レスポンス文字列に偶然マッチして誤検出する確率は事実上ゼロ。
    // クリック時は server.mjs の /file?path=... に通し、画像だけは軽量な
    // プレビュー/ダウンロードUIを出す。
    const localFileLinkProvider = terminal.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        try {
          const buf = terminal.buffer.active;
          const line = buf.getLine(bufferLineNumber - 1);
          if (!line) { callback(undefined); return; }
          // wrapped 行も含めて 1 論理行をまとめて取り出す
          let text = line.translateToString(true);
          // 折り返し行を結合
          let nextLine = buf.getLine(bufferLineNumber);
          while (nextLine && nextLine.isWrapped) {
            text += nextLine.translateToString(true);
            nextLine = buf.getLine((nextLine as any).lineNumber + 1);
          }
          const links: any[] = [];
          FILE_PATH_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = FILE_PATH_RE.exec(text)) !== null) {
            let pathStr = m[1];
            // チルダ展開: ~/ → /home/<user>/
            // ブラウザ側では HOME を知らないので、サーバ側の /file?path= が
            // 正規化してくれる前提でそのまま渡してもよいが、ここでは安全のため
            // クリック時に展開する設計にする(下記 activate 内)。
            const start = m.index;
            const end = start + pathStr.length;
            // xterm の link 座標は 1-indexed col/row
            links.push({
              range: {
                start: { x: start + 1, y: bufferLineNumber },
                end: { x: end, y: bufferLineNumber },
              },
              text: pathStr,
              activate(_event: MouseEvent, uri: string) {
                const url = sharedUrlForGeneratedPath(uri);
                if (IMAGE_EXT_RE.test(uri)) {
                  showImageActionForPath(uri);
                  return;
                }
                window.open(url, "_blank", "noopener,noreferrer");
              },
              hover() {/* no-op */},
              leave() {/* no-op */},
            });
          }
          callback(links.length ? links : undefined);
        } catch {
          callback(undefined);
        }
      },
    });
    // Plain Unicode 11 widths (East-Asian-Ambiguous = 1 column) — the same
    // wcwidth the CLIs inside (Claude Code / codex) use to position the cursor
    // and erase lines. Matching them avoids the cursor-drift that left ghost
    // characters in the buffer. ①②③ etc. don't overlap because the PlemolJP
    // Console font draws ambiguous characters as halfwidth to match.
    terminal.unicode.activeVersion = "11";

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    // The terminal bell rings when a CLI agent (Claude/codex) finishes or needs
    // input. Surface it as an "attention" signal so the user can run several
    // sessions and only check the one that pinged.
    const bellSub = terminal.onBell(() => {
      if (!visibleRef.current) onBellRef.current?.();
    });

    // Clear container before opening (prevents duplicate terminals from StrictMode remounts)
    while (termRef.current.firstChild) {
      termRef.current.removeChild(termRef.current.firstChild);
    }
    terminal.open(termRef.current);
    // scanTerminalForLatestImage は「そのセッションの scrollback にある画像パスを拾う」=
    // 自セッションの出力にしか反応しないので全 pane で走らせて OK。
    // 一方 loadLatestSharedImage は SHARED_DIR 全体の最新画像を返してしまうので、
    // ChatGPT (codex) セッションのみで発火させる (Claude/Terminal で他人が生成した
    // 画像プレビューが勝手に出るのを防ぐ)。
    const imageScanTimers: ReturnType<typeof setTimeout>[] = [
      setTimeout(scanTerminalForLatestImage, 300),
      setTimeout(scanTerminalForLatestImage, 1000),
    ];
    if (sessionType === "chatgpt") {
      imageScanTimers.push(setTimeout(loadLatestSharedImage, 1200));
    }

    // Initial fit: retry until container has real dimensions (Grid layout
    // may start at width=0 and expand later, causing cols=1 → vertical text).
    const initialFit = (attempt = 0) => {
      const container = termRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) {
        if (attempt < 20) setTimeout(() => initialFit(attempt + 1), 50);
        return;
      }
      try {
        const result = safeFit(fitAddon, terminal);
        if (result) {
          wsSend({ type: "resize", id: sessionId, cols: result.cols, rows: result.rows });
        }
      } catch {};
    };
    requestAnimationFrame(() => initialFit());

    // The server resumes/launches the agent ~500ms after the session starts, then
    // it draws its UI. By then the terminal size may have settled WITHOUT the
    // agent redrawing, leaving the input frame missing. Nudge a repaint once it's
    // up (two passes cover slow starts). Tracked so we can cancel on unmount.
    const redrawNudges = [
      setTimeout(nudgeRedraw, 900),
      setTimeout(nudgeRedraw, 2200),
    ];

    // Guard: when effect re-runs or cleans up, mark this instance as dead
    // so no stale closure can write to a disposed terminal
    let alive = true;

    // Font-load race: at launch the terminal can render BEFORE the custom font
    // (PlemolJP Console) is ready, so box-drawing — like Claude's input frame
    // ("白い線") — gets measured with a fallback font and stays broken. Once the
    // font is loaded, re-fit (cell size may change) and repaint so it's correct.
    if (typeof document !== "undefined" && (document as any).fonts) {
      const fonts: any = (document as any).fonts;
      const repaintForFont = () => {
        if (!alive) return;
        try {
          if (fitAddonRef.current) {
            const r = safeFit(fitAddonRef.current, terminal);
            if (r) wsSend({ type: "resize", id: sessionId, cols: r.cols, rows: r.rows });
          }
          // Force xterm to drop its cached character metrics and re-measure with
          // the now-loaded font. A plain refresh() reuses the stale fallback-font
          // cell size, so box-drawing — Claude's white input frame — stays broken
          // even after the real font arrives. Reassigning fontFamily invalidates
          // that cache; setting it back immediately means no visible flicker.
          const ff = terminal.options.fontFamily;
          terminal.options.fontFamily = "monospace";
          terminal.options.fontFamily = ff;
          terminal.refresh(0, terminal.rows - 1);
        } catch {}
      };
      try { fonts.load("14px 'PlemolJP Console'").then(repaintForFont).catch(() => {}); } catch {}
      try { fonts.ready.then(repaintForFont).catch(() => {}); } catch {}
      // Safety net: fonts.ready can resolve a hair before the row layout settles,
      // which still leaves the frame measured with the fallback font. One more
      // repaint shortly after reliably catches that race.
      setTimeout(repaintForFont, 400);
    }

    // PTY output from server
    let pendingData = "";
    let writeScheduled = false;
    const flushWrite = () => {
      if (!alive) return;
      if (pendingData) {
        terminal.write(pendingData);
        pendingData = "";
      }
      writeScheduled = false;
    };

    const unsubscribe = wsOnMessage((msg: any) => {
      if (!alive) return;
      if (msg.type === "pty_output" && msg.id === sessionId) {
        showImageActionForPath(latestImagePathFromText(msg.data));
        // Background task 検知 (v0.2.49 で導入):
        // 起動と完了を pty output から捕まえて pane ヘッダーのメーターと連動。
        const startMatch = msg.data.match(TASK_START_RE);
        if (startMatch && !activeTaskRef.current) {
          const started = { id: startMatch[1], startTime: Date.now() };
          activeTaskRef.current = started;
          setActiveTask(started);
          setTaskElapsedMs(0);
        }
        const doneMatch = msg.data.match(TASK_DONE_RE);
        if (doneMatch && activeTaskRef.current && activeTaskRef.current.id === doneMatch[1]) {
          const duration = Date.now() - activeTaskRef.current.startTime;
          updateTaskAvgMs(duration);
          activeTaskRef.current = null;
          setActiveTask(null);
        }
        // 2026-07-01 v0.2.51: hidden 中もそのまま terminal.write する
        // (以前は bufferedDataRef に貯めて可視化時に一括書き込み → 可視化が
        // 重くなり黒い時間の原因の一つだった)。TerminalGrid で hidden pane
        // を 100% サイズで offscreen に置くようになったので、xterm は正しい
        // dimensions のまま描画継続 → 可視化はレイヤー切替だけで一瞬。
        pendingData += msg.data;
        if (!writeScheduled) {
          writeScheduled = true;
          requestAnimationFrame(flushWrite);
        }
      }
      if (msg.type === "generated_image" && msg.id === sessionId && typeof msg.path === "string") {
        showImageActionForPath(msg.path);
      }
      if (msg.type === "session_exited" && msg.id === sessionId) {
        terminal.write("\r\n\x1b[90m[Session ended]\x1b[0m\r\n");
      }
      // File uploaded → send path to PTY
      if (msg.type === "file_uploaded" && msg.sessionId === sessionId) {
        const escaped = msg.path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        wsSend({ type: "write", id: sessionId, data: `"${escaped}" ` });
      }
    });

    // Send user input to server
    const onData = terminal.onData((data) => {
      if (!alive) return;
      wsSend({ type: "write", id: sessionId, data });
    });

    // "Lighten everything" — drop the scrolled-off history to free memory, and
    // redraw the current screen so any leftover/garbled characters are wiped.
    //   • terminal.clear() drops all scrollback above the current line (the old
    //     "toggle the scrollback option" trick did nothing in xterm 6 — that's
    //     why the button appeared to do nothing).
    //   • Sending Ctrl+L (\x0c) tells the program inside (shell / Claude / codex)
    //     to clear and repaint, which is what actually removes burned-in glitch
    //     characters from the visible screen.
    const clearHandler = () => {
      try {
        terminal.clear();
        terminal.scrollToBottom();
        terminal.refresh(0, terminal.rows - 1);
      } catch {}
      wsSend({ type: "clear_scrollback", id: sessionId, keepTail: true });
      wsSend({ type: "write", id: sessionId, data: "\x0c" });
    };
    window.addEventListener("ibis-clear-all", clearHandler);

    // 2026-06-26 Shift+wheel 対応:
    //   Edge/Chrome のデフォルトでは Shift+wheel が「水平スクロール」に割当られ、
    //   xterm.js の wheel handler に届かない。結果として Shift+ドラッグで選択中に
    //   スクロールバックを延ばせず「画面に映ってる分しか選択できない」状態だった。
    //   capture phase で先取りして shiftKey の時は scrollLines() に振り替える。
    const handleShiftWheel = (e: WheelEvent) => {
      if (!e.shiftKey) return; // 通常 wheel は xterm 既定処理に任せる
      e.preventDefault();
      e.stopPropagation();
      try {
        // Alt Screen Buffer (Claude Code TUI 等) 使用中は xterm レベルの
        // scrollLines() が効かないので PTY に PageUp/PageDown を送信する
        // 経路に振り替える。Claude/codex 側で自分の履歴を上下する。
        const isAlt = terminal.buffer.active.type === "alternate";
        if (isAlt) {
          const seq = e.deltaY < 0 ? "\x1b[5~" : "\x1b[6~";
          wsSend({ type: "write", id: sessionId, data: seq });
        } else {
          // Normal Buffer: xterm 側の scrollback を直接動かす
          const lines = Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 30));
          terminal.scrollLines(lines);
        }
      } catch {}
    };
    const termContainerForWheel = termRef.current;
    termContainerForWheel?.addEventListener("wheel", handleShiftWheel, { passive: false, capture: true });

    // Right-click: Windows Terminal style smart copy/paste.
    // The copy-vs-paste decision is delegated to the unit-tested
    // `decideRightClick` pure function so test and production stay in sync.
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!alive) return;
      // 2026-06-26 復元: 右クリックも effectiveSel 経由で xterm 選択 + DOM 選択を統合判定。
      const xtermSel2 = terminal.getSelection();
      const domSel2 = (typeof window !== "undefined" && window.getSelection)
        ? (window.getSelection()?.toString() || "")
        : "";
      const effectiveSel2 = xtermSel2 || domSel2;
      const action = decideRightClick(!!effectiveSel2);
      if (action === "copy") {
        if (effectiveSel2) {
          copyToClipboard(effectiveSel2);
          terminal.clearSelection();
          window.getSelection()?.removeAllRanges();
        }
      } else if (navigator.clipboard?.readText) {
        // 右クリック paste は async clipboard API 必須 (secure context + 権限)。
        // 使えない環境では Ctrl/Cmd+V (handlePaste 経由) で代替。
        navigator.clipboard
          .readText()
          .then((text) => {
            if (alive) wsSend({ type: "write", id: sessionId, data: text });
          })
          .catch(() => {});
      }
    };
    const containerEl = termRef.current;
    // Use capture phase so we win over any addon (e.g. WebLinksAddon) that
    // might attach a contextmenu listener on a child element.
    containerEl?.addEventListener("contextmenu", handleContextMenu, true);

    // Single owner for ALL pasting. A Cmd+V / Ctrl+Shift+V fires a DOM "paste"
    // event on xterm's hidden textarea; xterm has its own listener on that
    // textarea that would emit the text through onData. To guarantee the
    // pasted text is sent exactly ONCE (the "2個ペーストされる" bug), we catch
    // the paste in the capture phase on the container — which runs before the
    // textarea's own listener — send it ourselves, and stop propagation so
    // xterm never also handles it.
    const handlePaste = (e: ClipboardEvent) => {
      if (!alive) return;
      const text = e.clipboardData?.getData("text");
      if (text) {
        e.preventDefault();
        e.stopImmediatePropagation();
        wsSend({ type: "write", id: sessionId, data: text });
      }
    };
    containerEl?.addEventListener("paste", handlePaste, true);

    // Alt(Option)+Click: move caret to clicked position by sending arrow keys.
    // Works on Mac (Option) and Win/Linux (Alt) — both map to e.altKey.
    // Listen on document in capture phase so xterm.js internal mouse handlers
    // (which may stopPropagation on .xterm-screen children) can't swallow it.
    // Rendering/font/unicode untouched — this only sends input to PTY.
    const handleAltClick = (e: MouseEvent) => {
      if (!alive) return;
      if (!e.altKey) return;
      if (e.button !== 0) return;
      if (!containerEl?.contains(e.target as Node)) return;
      if (terminal.hasSelection()) return;

      const screen = terminal.element?.querySelector(".xterm-screen") as HTMLElement | null;
      if (!screen) return;
      const rect = screen.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const cellWidth = rect.width / terminal.cols;
      const cellHeight = rect.height / terminal.rows;
      if (cellWidth <= 0 || cellHeight <= 0) return;

      const targetCol = Math.max(
        0,
        Math.min(terminal.cols - 1, Math.floor((e.clientX - rect.left) / cellWidth)),
      );
      const targetRow = Math.max(
        0,
        Math.min(terminal.rows - 1, Math.floor((e.clientY - rect.top) / cellHeight)),
      );

      const buffer = terminal.buffer.active;
      const cursorCol = buffer.cursorX;
      const cursorRow = buffer.cursorY;

      const colDiff = targetCol - cursorCol;
      const rowDiff = targetRow - cursorRow;
      if (colDiff === 0 && rowDiff === 0) return;

      let seq = "";
      if (rowDiff > 0) seq += "\x1b[B".repeat(rowDiff);
      else if (rowDiff < 0) seq += "\x1b[A".repeat(-rowDiff);
      if (colDiff > 0) seq += "\x1b[C".repeat(colDiff);
      else if (colDiff < 0) seq += "\x1b[D".repeat(-colDiff);

      if (seq) {
        e.preventDefault();
        e.stopPropagation();
        wsSend({ type: "write", id: sessionId, data: seq });
      }
    };
    document.addEventListener("mousedown", handleAltClick, true);

    const observer = new ResizeObserver(() => handleResize());
    observer.observe(termRef.current);

    return () => {
      alive = false;
      imageScanTimers.forEach(clearTimeout);
      redrawNudges.forEach(clearTimeout);
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      observer.disconnect();
      containerEl?.removeEventListener("contextmenu", handleContextMenu, true);
      containerEl?.removeEventListener("paste", handlePaste, true);
      document.removeEventListener("mousedown", handleAltClick, true);
      window.removeEventListener("ibis-clear-all", clearHandler);
      termContainerForWheel?.removeEventListener("wheel", handleShiftWheel, true);
      try { localFileLinkProvider.dispose(); } catch {}
      bellSub.dispose();
      onData.dispose();
      unsubscribe();
      searchAddonRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId, sessionType, handleResize, wsSend, wsOnMessage, nudgeRedraw, scanTerminalForLatestImage, showImageActionForPath, loadLatestSharedImage]);

  return (
    <div
      ref={rootRef}
      data-session-id={sessionId}
      className={`flex flex-col bg-bg min-h-0 h-full w-full relative overflow-hidden ${dragOver ? "ring-2 ring-accent ring-inset" : ""}`}
      {...(!isTauri ? {
        onDragEnter: (e: React.DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          dragDepthRef.current++;
          setDragOver(true);
        },
        onDragOver: (e: React.DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
        },
        onDragLeave: (e: React.DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          dragDepthRef.current--;
          if (dragDepthRef.current <= 0) {
            dragDepthRef.current = 0;
            setDragOver(false);
          }
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          dragDepthRef.current = 0;
          setDragOver(false);
          if (e.dataTransfer.files.length > 0) {
            handleFileDrop(e.dataTransfer.files);
          }
        },
      } : {})}
    >
      <div className="flex items-center justify-between px-2 py-1 bg-surface border-b border-border gap-2">
        <span className="text-sm text-text-muted font-medium truncate shrink">{sessionName}</span>
        {activeTask && (() => {
          // 過去平均を基準に進行率を算出。平均が無ければ pulse アニメで動きを出す。
          const avg = loadTaskAvgMs();
          const pct = avg.avgMs > 0 ? Math.min(100, (taskElapsedMs / avg.avgMs) * 100) : 20;
          const barColor =
            avg.avgMs > 0 && taskElapsedMs > avg.avgMs * 1.2 ? "bg-danger" :
            avg.avgMs > 0 && taskElapsedMs > avg.avgMs ? "bg-warning" :
            "bg-accent";
          const remaining = avg.avgMs > 0 ? Math.max(0, avg.avgMs - taskElapsedMs) : 0;
          return (
            <div
              className="flex items-center gap-1.5 shrink min-w-0"
              title={
                avg.avgMs > 0
                  ? `Background task ${activeTask.id}\n経過 ${formatMs(taskElapsedMs)} / 過去平均 ${formatMs(avg.avgMs)}\n残り推定 ${formatMs(remaining)}`
                  : `Background task ${activeTask.id}\n経過 ${formatMs(taskElapsedMs)} (過去平均なし)`
              }
            >
              <span className="text-[11px] font-mono text-text-muted tabular-nums whitespace-nowrap">
                {formatMs(taskElapsedMs)}
                {avg.avgMs > 0 && (
                  <span className="text-text-muted/60">
                    {" / "}
                    {formatMs(avg.avgMs)}
                  </span>
                )}
              </span>
              <div className="w-20 h-1.5 bg-surface-hover rounded-full overflow-hidden shrink-0">
                <div
                  className={`h-full ${barColor} transition-all duration-300 ${avg.avgMs === 0 ? "animate-pulse" : ""}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })()}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => wsSend({ type: "pick_files", sessionId })}
            className="text-base text-accent hover:text-accent-hover px-3 py-1 rounded hover:bg-surface-hover font-medium"
            title="ファイル・フォルダ選択"
          >
            + File
          </button>
          {showControls && (
            <>
            <button
              onClick={onDetach}
              className="text-xs text-text-muted hover:text-text px-1.5 py-0.5 rounded hover:bg-surface-hover"
              title="Detach from grid"
            >
              ⊟
            </button>
            <button
              onClick={onClose}
              className="text-xs text-text-muted hover:text-danger px-1.5 py-0.5 rounded hover:bg-surface-hover"
              title="Close session"
            >
              ✕
            </button>
            </>
          )}
        </div>
      </div>
      {showSearch && (
        <div className="absolute top-9 right-2 z-20 flex items-center gap-1 bg-surface border border-border rounded-md shadow-lg px-2 py-1">
          <input
            ref={searchInputRef}
            value={searchTerm}
            placeholder="検索…"
            className="bg-transparent text-sm text-text outline-none w-40"
            onChange={(e) => {
              setSearchTerm(e.target.value);
              searchAddonRef.current?.findNext(e.target.value, { incremental: true });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) searchAddonRef.current?.findPrevious(searchTerm);
                else searchAddonRef.current?.findNext(searchTerm);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setShowSearch(false);
                searchAddonRef.current?.clearDecorations();
                terminalRef.current?.focus();
              }
            }}
          />
          <button
            onClick={() => searchAddonRef.current?.findPrevious(searchTerm)}
            className="text-xs text-text-muted hover:text-text px-1"
            title="前へ (Shift+Enter)"
          >▲</button>
          <button
            onClick={() => searchAddonRef.current?.findNext(searchTerm)}
            className="text-xs text-text-muted hover:text-text px-1"
            title="次へ (Enter)"
          >▼</button>
          <button
            onClick={() => {
              setShowSearch(false);
              searchAddonRef.current?.clearDecorations();
              terminalRef.current?.focus();
            }}
            className="text-xs text-text-muted hover:text-danger px-1"
            title="閉じる (Esc)"
          >✕</button>
        </div>
      )}
      {imageAction && !actionBarMinimized && (
        <div className="absolute top-9 left-2 right-2 z-20 flex flex-col gap-1.5 bg-surface border border-border rounded-md shadow-lg px-2 py-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-medium text-text truncate">{imageAction.fileName}</div>
              <div className="text-[11px] text-text-muted truncate">生成画像</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => {
                  setPreviewFailed(false);
                  setPreviewOpen(true);
                }}
                className="text-xs text-text hover:text-accent px-2 py-1 rounded hover:bg-surface-hover"
                title="画像をプレビュー"
              >
                プレビュー
              </button>
              <button
                onClick={() => downloadSharedFile(imageAction.url, imageAction.fileName)}
                className="text-xs text-bg bg-accent hover:bg-accent-hover px-2 py-1 rounded font-medium"
                title="保存先を選んでダウンロード"
              >
                ダウンロード
              </button>
              <button
                onClick={() => copyToClipboard(imageAction.path)}
                className="text-xs text-text-muted hover:text-text px-2 py-1 rounded hover:bg-surface-hover"
                title="ファイルパスをコピー"
              >
                パス
              </button>
              <button
                onClick={() => setActionBarMinimized(true)}
                className="text-xs text-text-muted hover:text-text px-2 py-1 rounded hover:bg-surface-hover"
                title="最小化 (右上バッジに畳む)"
              >
                ＿
              </button>
              <button
                onClick={() => { setImageAction(null); setImageHistory([]); }}
                className="text-xs text-text-muted hover:text-danger px-1.5 py-1 rounded hover:bg-surface-hover"
                title="閉じる (履歴も破棄)"
              >
                ✕
              </button>
            </div>
          </div>
          {imageHistory.length > 1 && (
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
              <span className="text-[10px] text-text-muted shrink-0 pr-0.5">履歴</span>
              {imageHistory.map((item) => {
                const isActive = item.path === imageAction.path;
                return (
                  <button
                    key={item.path}
                    onClick={() => {
                      setImageAction(item);
                      setPreviewFailed(false);
                    }}
                    className={`relative shrink-0 rounded overflow-hidden border transition ${
                      isActive
                        ? "border-accent ring-1 ring-accent"
                        : "border-border hover:border-accent/60"
                    }`}
                    title={item.fileName}
                    style={{ width: 40, height: 40 }}
                  >
                    <img src={item.url} alt={item.fileName} className="w-full h-full object-cover" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      {imageAction && actionBarMinimized && (
        <button
          onClick={() => setActionBarMinimized(false)}
          className="absolute top-9 right-2 z-20 flex items-center gap-1.5 bg-surface border border-border hover:border-accent rounded-full pl-1 pr-2.5 py-1 shadow-lg text-xs text-text"
          title="画像アクションを開く"
        >
          <img src={imageAction.url} alt="" className="w-5 h-5 rounded-full object-cover" />
          <span className="truncate max-w-[100px]">
            {imageHistory.length > 1 ? `${imageHistory.length} 枚` : imageAction.fileName}
          </span>
        </button>
      )}
      {imageAction && previewOpen && !previewMinimized && (
        <div
          className="absolute inset-0 z-30 bg-bg/90 flex flex-col"
          onClick={() => setPreviewOpen(false)}
        >
          <div className="flex items-center justify-between gap-2 bg-surface border-b border-border px-3 py-2">
            <div className="min-w-0">
              <div className="text-sm font-medium text-text truncate">{imageAction.fileName}</div>
              <div className="text-[11px] text-text-muted truncate">{imageAction.path}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  downloadSharedFile(imageAction.url, imageAction.fileName);
                }}
                className="text-xs text-bg bg-accent hover:bg-accent-hover px-2 py-1 rounded font-medium"
                title="保存先を選んでダウンロード"
              >
                ダウンロード
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  copyToClipboard(imageAction.url);
                }}
                className="text-xs text-text-muted hover:text-text px-2 py-1 rounded hover:bg-surface-hover"
                title="プレビューURLをコピー"
              >
                URL
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setPreviewMinimized(true);
                }}
                className="text-xs text-text-muted hover:text-text px-2 py-1 rounded hover:bg-surface-hover"
                title="最小化 (右下バッジに畳む)"
              >
                ＿
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setPreviewOpen(false);
                }}
                className="text-xs text-text-muted hover:text-danger px-1.5 py-1 rounded hover:bg-surface-hover"
                title="閉じる"
              >
                ✕
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0 flex items-center justify-center p-3" onClick={(e) => e.stopPropagation()}>
            {previewFailed ? (
              <div className="max-w-full rounded-md border border-border bg-surface px-4 py-3 text-sm text-text">
                <div className="font-medium mb-1">画像を読み込めませんでした</div>
                <button
                  onClick={() => copyToClipboard(imageAction.url)}
                  className="text-xs text-accent hover:text-accent-hover"
                >
                  URLをコピー
                </button>
              </div>
            ) : (
              <img
                src={imageAction.url}
                alt={imageAction.fileName}
                className="max-w-full max-h-full object-contain rounded-md"
                onError={() => setPreviewFailed(true)}
              />
            )}
          </div>
          {imageHistory.length > 1 && (
            <div
              className="shrink-0 bg-surface border-t border-border px-3 py-2 overflow-x-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-text-muted shrink-0 pr-1">履歴</span>
                {imageHistory.map((item) => {
                  const isActive = item.path === imageAction.path;
                  return (
                    <button
                      key={item.path}
                      onClick={(e) => {
                        e.stopPropagation();
                        setImageAction(item);
                        setPreviewFailed(false);
                      }}
                      className={`relative shrink-0 rounded-md overflow-hidden border transition ${
                        isActive
                          ? "border-accent ring-1 ring-accent"
                          : "border-border hover:border-accent/60"
                      }`}
                      title={item.fileName}
                      style={{ width: 56, height: 56 }}
                    >
                      <img
                        src={item.url}
                        alt={item.fileName}
                        className="w-full h-full object-cover"
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
      {imageAction && previewOpen && previewMinimized && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setPreviewMinimized(false);
          }}
          className="absolute bottom-3 right-3 z-30 flex items-center gap-2 bg-surface border border-border hover:border-accent rounded-full pl-1 pr-3 py-1 shadow-lg text-xs text-text"
          title="プレビューを開く"
        >
          <img
            src={imageAction.url}
            alt=""
            className="w-6 h-6 rounded-full object-cover"
          />
          <span className="truncate max-w-[120px]">
            {imageHistory.length > 1 ? `${imageHistory.length} 枚` : imageAction.fileName}
          </span>
        </button>
      )}
      <div ref={termRef} className="flex-1 min-h-0 min-w-0 overflow-hidden" />
      {dragOver && (
        <div className="absolute inset-0 bg-accent/10 flex items-center justify-center pointer-events-none z-10">
          <div className="bg-surface border border-accent rounded-lg px-6 py-3 text-text font-medium shadow-lg pointer-events-none">
            Drop files here
          </div>
        </div>
      )}
    </div>
  );
}
