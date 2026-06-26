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
  const dragDepthRef = useRef(0);
  const MAX_UPLOAD_SIZE = 100 * 1024 * 1024; // 100MB
  // Cap buffered output for hidden panes. Kept modest so many idle background
  // sessions don't balloon memory (a cause of the app feeling heavy).
  const MAX_BUFFER_SIZE = 2 * 1024 * 1024; // 2MB max buffer for hidden terminals

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

  // Flush buffered data, refit, and scroll to bottom when becoming visible
  useEffect(() => {
    visibleRef.current = isVisible;
    if (isVisible && terminalRef.current) {
      const terminal = terminalRef.current;
      if (bufferedDataRef.current) {
        terminal.write(bufferedDataRef.current);
        bufferedDataRef.current = "";
      }
      // Defer fit + repaint to the next frame, once the re-shown pane actually
      // has real layout dimensions (doing it while the element is still 0×0
      // leaves it blank).
      requestAnimationFrame(() => {
        try {
          if (fitAddonRef.current) {
            const result = safeFit(fitAddonRef.current, terminal);
            if (result) {
              wsSend({ type: "resize", id: sessionId, cols: result.cols, rows: result.rows });
            }
          }
        } catch {}
        // Force a full repaint: re-showing a hidden pane does not auto-redraw,
        // so without this it stays blank until the next keystroke/output.
        try { terminal.refresh(0, terminal.rows - 1); } catch {}
        terminal.scrollToBottom();
        // The agent may have drawn its frame at a different size while hidden;
        // nudge it to repaint at the now-visible size so the input frame is right.
        setTimeout(nudgeRedraw, 80);
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
      // 2026-06-26 Esc 単独で入力中断:
      //   現状の Esc は xterm.js のデフォルトで \x1b として PTY に流れるが、
      //   それだけだと claude/codex の「行クリア」が確実に発火しないため、
      //   \x1b の直後に \x15 (Ctrl+U / unix-line-discard) も送って readline の
      //   「カーソル前の入力をクリア」を強制発火させる。応答 streaming 中の
      //   Esc は claude/codex 側が \x1b 単独受信で中断するので、Ctrl+U が
      //   余計に送られても入力プロンプトに戻ったタイミングで no-op になる。
      if (
        e.type === "keydown" &&
        e.key === "Escape" &&
        !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey &&
        !e.isComposing
      ) {
        e.preventDefault();
        wsSend({ type: "write", id: sessionId, data: "\x1b\x15" });
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
    const FILE_PATH_RE =
      /(?<=^|[\s\(\[{<'"`])((?:\/|~\/)[^\s\x00-\x1f<>"|]+\.(?:png|jpe?g|gif|webp|bmp|pdf))/gi;
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
                // ~/ で始まるなら $HOME に展開。サーバ側で再度正規化される。
                let absPath = uri;
                if (absPath.startsWith("~/")) {
                  // HOME を取得できないので、サーバ側に渡して resolve させる方針:
                  // ホームディレクトリ判定はサーバ側で行うので、~/ を含むパスは
                  // 暫定的にそのまま渡す(サーバ側で path.resolve すれば
                  // /home/<user>/.../ に展開はされないので、別経路として
                  // process.env.HOME の取り扱いはサーバ側で必要。ここでは
                  // 簡易対応として、まずは絶対パスのみリンク化対象とする)
                  // → ~/ で始まるリンクは諦めて何もしない (絶対パスのみ対応)
                  return;
                }
                const url = `/file?path=${encodeURIComponent(absPath)}`;
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
        // Buffer data when hidden, write directly when visible
        if (!visibleRef.current) {
          bufferedDataRef.current += msg.data;
          // Cap buffer to prevent OOM with fast output on hidden terminals
          if (bufferedDataRef.current.length > MAX_BUFFER_SIZE) {
            bufferedDataRef.current = bufferedDataRef.current.slice(-MAX_BUFFER_SIZE);
          }
          return;
        }
        pendingData += msg.data;
        if (!writeScheduled) {
          writeScheduled = true;
          requestAnimationFrame(flushWrite);
        }
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
        // deltaY 正 = 下方向。1 notch ≒ 100px → 約 3 行が標準的な体感量
        const lines = Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 30));
        terminal.scrollLines(lines);
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
  }, [sessionId, handleResize, wsSend, wsOnMessage, nudgeRedraw]);

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
      <div className="flex items-center justify-between px-2 py-1 bg-surface border-b border-border">
        <span className="text-sm text-text-muted font-medium truncate">{sessionName}</span>
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
