import { WebSocketServer } from "ws";
import { createServer } from "http";
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, openSync, readSync, closeSync, renameSync, realpathSync } from "fs";
import { join, extname, resolve as pathResolve, sep as pathSep } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { homedir, tmpdir, platform } from "os";
import { execSync, spawnSync, spawn } from "child_process";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DIST_DIR = join(__dirname, "dist");
// Namespace per-instance state by port so a second instance (e.g. PORT=9101)
// keeps its own session list / scrollback and doesn't fight with the main one.
const INSTANCE_SUFFIX = (process.env.PORT && process.env.PORT !== "9100") ? `.${process.env.PORT}` : "";
const SESSIONS_FILE = join(__dirname, `.sessions${INSTANCE_SUFFIX}.json`);
// On-disk copy of each session's terminal output, so the screen is restored
// (not blank) after Ibis Hub is killed and relaunched.
const SCROLLBACK_DIR = join(__dirname, `.sessions-data${INSTANCE_SUFFIX}`);
try { mkdirSync(SCROLLBACK_DIR, { recursive: true }); } catch {}

function scrollbackPath(id) {
  return join(SCROLLBACK_DIR, `${id}.log`);
}
function writeScrollbackToDisk(session) {
  try { writeFileSync(scrollbackPath(session.id), session.scrollback || "", "utf-8"); } catch {}
}
function readScrollbackFromDisk(id) {
  try { return readFileSync(scrollbackPath(id), "utf-8"); } catch { return ""; }
}
function deleteScrollbackFromDisk(id) {
  try { unlinkSync(scrollbackPath(id)); } catch {}
}

// Claude session ids already assigned to a session, so two sessions can never
// resume the SAME conversation (which would make them mirror each other).
const claimedClaudeIds = new Set();

// List Claude Code transcript ids for a cwd, newest first. Claude stores them
// under ~/.claude/projects/<encoded-cwd>/<id>.jsonl.
function listClaudeSessionIds(cwd) {
  try {
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const dir = join(homedir(), ".claude", "projects", encoded);
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ id: f.replace(/\.jsonl$/, ""), m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .map((x) => x.id);
  } catch {
    return [];
  }
}

// True once Claude has written this conversation's transcript to disk (it only
// does so AFTER the first message). We resume by id only when the file exists;
// otherwise we re-open the same id fresh, since `--resume` on a non-existent
// transcript fails.
function claudeTranscriptExists(cwd, id) {
  try {
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    return existsSync(join(homedir(), ".claude", "projects", encoded, `${id}.jsonl`));
  } catch {
    return false;
  }
}

// One-time recovery map. These tabs had their Claude session blocked by the
// bypass-permissions disclaimer, so they never wrote a transcript and their
// recorded id points at an empty conversation. Re-point them to the real prior
// conversation that's still on disk, so --resume brings the content back. Once
// restored, the corrected id is persisted, so this map can be emptied later.
const CLAUDE_ID_RECOVERY = {
  "6e436175-d111-44b8-99d5-769fd26af66a": "9c027586-0c81-4bed-8d56-6b76b3c119ad", // 物販マニュアル
  "0729a801-241b-4618-a09d-9fd812184bc8": "834e0edd-37dd-4ef7-b72e-894d8d170e92", // HUB構築（代理店・パートナー管理）
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function claudeProjectDir(cwd) {
  return join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}
// Read just the bytes we need from a (possibly large) transcript: the tail for
// the latest `ai-title` (Claude's friendly summary) and the head for the first
// user message as a fallback label. Avoids parsing multi-MB files in full.
function readFileSlice(path, fromEnd, bytes) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    const start = fromEnd ? Math.max(0, size - bytes) : 0;
    const len = Math.min(bytes, size - start);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString("utf-8");
  } catch { return ""; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}
function conversationTitle(path) {
  // Latest ai-title line lives near the end.
  const tail = readFileSlice(path, true, 256 * 1024);
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('"ai-title"')) {
      try { const t = JSON.parse(lines[i]).aiTitle; if (t) return String(t); } catch {}
    }
  }
  // Fallback: first user message from the head.
  const head = readFileSlice(path, false, 64 * 1024);
  for (const line of head.split("\n")) {
    if (line.includes('"type":"user"')) {
      try {
        let c = JSON.parse(line).message?.content ?? "";
        if (Array.isArray(c)) c = c.map((x) => (x && x.text) || "").join(" ");
        c = String(c).replace(/\s+/g, " ").trim();
        if (c) return c.slice(0, 80);
      } catch {}
    }
  }
  return "(無題)";
}
// List a folder's saved Claude conversations, newest first, with friendly
// titles — the data behind the "過去のチャット" panel.
function listConversations(cwd) {
  const dir = claudeProjectDir(cwd);
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
  return files
    .map((f) => {
      const id = f.replace(/\.jsonl$/, "");
      const full = join(dir, f);
      let mtime = 0, size = 0;
      try { const st = statSync(full); mtime = st.mtimeMs; size = st.size; } catch {}
      // Prefer the tab name the user gave this conversation; fall back to
      // Claude's auto title. Show the auto title as a subtitle when it differs,
      // so a user-named tab still carries a hint of what the chat was about.
      const aiTitle = conversationTitle(full);
      const tabName = conversationNames[id];
      const title = tabName || aiTitle;
      const subtitle = tabName && aiTitle && aiTitle !== tabName ? aiTitle : "";
      return { id, mtime, sizeBytes: size, title, subtitle };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// Capture the id of the transcript a freshly-launched `claude` just created by
// diffing against a snapshot taken before launch — so each session is tied to
// its OWN conversation, even when several share one directory. Returns the new,
// not-yet-claimed id, or null if none appeared (e.g. user hasn't typed yet).
function captureNewClaudeSessionId(cwd, beforeIds) {
  const before = new Set(beforeIds);
  for (const id of listClaudeSessionIds(cwd)) {
    if (!before.has(id) && !claimedClaudeIds.has(id)) {
      claimedClaudeIds.add(id);
      return id;
    }
  }
  return null;
}
const PORT = parseInt(process.env.PORT || "9100", 10);
if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid PORT: ${process.env.PORT}`);
  process.exit(1);
}

// Try to load node-pty, fall back to child_process
let pty = null;
try {
  pty = (await import("node-pty")).default;
  // Test if it actually works
  const test = pty.spawn(process.env.SHELL || "/bin/bash", ["-c", "echo ok"], {
    name: "xterm-256color", cols: 80, rows: 24, cwd: homedir(),
    env: { ...process.env, TERM: "xterm-256color" },
  });
  test.kill();
  console.log("Using node-pty for terminal");
} catch (e) {
  pty = null;
  console.log("node-pty unavailable, using child_process fallback");
}

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
};

// ローカルファイルをブラウザに配信するエンドポイント (2026-06-26 追加 / 強化):
//   xterm 上の画像パスをクリックでプレビューできるようにする。
//
//   セキュリティ対策 (security review 2026-06-26 反映):
//   ① 拡張子は **画像系のみ** に絞る (.json/.md/.txt/.csv は外す → .sessions.json
//      や ~/.claude/projects/*.jsonl 等の機密漏洩を防ぐ)
//   ② .svg は **削除** (SVG 内の <script> が同一 origin で実行される XSS 経路)
//   ③ realpathSync で symlink を実体パスに展開してから封じ込めチェック
//      (path.resolve は字面の .. 解決だけで symlink は dereference しない)
//   ④ 機密ディレクトリ (.claude/.codex/.ssh/.git/.config/.cache) は明示的に弾く
//   ⑤ レスポンスに nosniff + sandbox CSP を付与
const ALLOWED_FILE_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
  ".pdf",
]);
// 機密ディレクトリ: home 直下のこれらの配下はアクセス禁止
const FORBIDDEN_DIR_NAMES = new Set([
  ".claude", ".codex", ".ssh", ".gnupg", ".git", ".config", ".cache",
  ".local", ".npm", ".aws", ".docker", ".kube",
]);
function handleFileRequest(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const raw = url.searchParams.get("path");
    if (!raw) { res.writeHead(400); res.end("missing path"); return; }
    const decoded = decodeURIComponent(raw);
    // ① 字面正規化
    const lexicalAbs = pathResolve(decoded);
    if (!existsSync(lexicalAbs) || !statSync(lexicalAbs).isFile()) {
      res.writeHead(404); res.end("not found"); return;
    }
    // ② 実体パスに展開 (symlink dereference) してから封じ込めチェック
    let realAbs;
    let homeReal;
    try {
      realAbs = realpathSync(lexicalAbs);
      homeReal = realpathSync(homedir());
    } catch {
      res.writeHead(403); res.end("forbidden path"); return;
    }
    if (realAbs !== homeReal && !realAbs.startsWith(homeReal + pathSep)) {
      res.writeHead(403); res.end("forbidden path"); return;
    }
    // ③ 機密ディレクトリの配下は弾く (~/.claude/* 等)
    const relFromHome = realAbs.slice(homeReal.length + 1).split(pathSep);
    if (relFromHome.length > 0 && FORBIDDEN_DIR_NAMES.has(relFromHome[0])) {
      res.writeHead(403); res.end("forbidden directory"); return;
    }
    // ④ 拡張子ホワイトリスト
    const ext = extname(realAbs).toLowerCase();
    if (!ALLOWED_FILE_EXT.has(ext)) {
      res.writeHead(403); res.end("forbidden extension"); return;
    }
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const data = readFileSync(realAbs);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      // ⑤ MIME 推定攻撃防止 + 同 origin スクリプト実行抑制
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    });
    res.end(data);
  } catch (e) {
    res.writeHead(500); res.end(`error: ${e.message}`);
  }
}

const httpServer = createServer((req, res) => {
  // /file?path=<absolute> はローカルファイル配信専用エンドポイント
  if (req.url && req.url.startsWith("/file?")) {
    return handleFileRequest(req, res);
  }
  let filePath = join(DIST_DIR, req.url === "/" ? "index.html" : req.url);
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = join(DIST_DIR, "index.html");
  }
  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  try {
    const data = readFileSync(filePath);
    const header = contentType.startsWith("text/") ? `${contentType}; charset=utf-8` : contentType;
    res.writeHead(200, { "Content-Type": header });
    res.end(data);
  } catch {
    res.writeHead(500);
    res.end("Internal Server Error");
  }
});

const wss = new WebSocketServer({ server: httpServer });
const sessions = new Map();

// Persistent ledger of claudeSessionId -> the tab name the user gave it. Tab
// names are far more recognizable than Claude's auto titles in the "過去のチャット"
// list, but they'd vanish when a tab closes (close removes it from sessions).
// We keep them here so a conversation keeps its human name forever.
const NAMES_FILE = join(__dirname, `.conversation-names${INSTANCE_SUFFIX}.json`);
let conversationNames = {};
try {
  if (existsSync(NAMES_FILE)) conversationNames = JSON.parse(readFileSync(NAMES_FILE, "utf-8")) || {};
} catch { conversationNames = {}; }

// Save session metadata to disk (name, type, cwd — not PTY state)
function saveSessionsToDisk() {
  try {
    const list = Array.from(sessions.values()).map((s) => ({
      id: s.id, name: s.name, cwd: s.cwd, sessionType: s.sessionType,
      claudeSessionId: s.claudeSessionId || null,
      autoYes: !!s.autoYes, // keep the auto-Yes toggle across restarts
    }));
    writeFileSync(SESSIONS_FILE, JSON.stringify(list), "utf-8");
    // Merge current tab names into the ledger so they survive the tab closing.
    let changed = false;
    for (const s of sessions.values()) {
      if (s.claudeSessionId && s.name && conversationNames[s.claudeSessionId] !== s.name) {
        conversationNames[s.claudeSessionId] = s.name;
        changed = true;
      }
    }
    if (changed) { try { writeFileSync(NAMES_FILE, JSON.stringify(conversationNames), "utf-8"); } catch {} }
  } catch {}
}

// Restore sessions from disk on startup
function restoreSessionsFromDisk() {
  try {
    if (!existsSync(SESSIONS_FILE)) return [];
    const data = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
    if (!Array.isArray(data)) return [];
    return data;
  } catch { return []; }
}

function createPtySession(shell, args, cwd, cols, rows) {
  if (pty) {
    const proc = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols: cols || 80,
      rows: rows || 24,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    });
    return {
      onData: (cb) => proc.onData(cb),
      onExit: (cb) => proc.onExit(cb),
      write: (data) => proc.write(data),
      resize: (c, r) => { try { proc.resize(c, r); } catch {} },
      kill: () => proc.kill(),
    };
  }

  // Fallback: use `script` command to create a real PTY via child_process
  const plat = platform();
  let scriptCmd, scriptArgs;
  if (plat === "darwin") {
    // macOS: script -q /dev/null shell args...
    scriptCmd = "script";
    scriptArgs = ["-q", "/dev/null", shell, ...args];
  } else {
    // Linux: script -qc "shell args..." /dev/null
    const fullCmd = [shell, ...args].map(a => `'${a}'`).join(" ");
    scriptCmd = "script";
    scriptArgs = ["-qc", fullCmd, "/dev/null"];
  }

  const proc = spawn(scriptCmd, scriptArgs, {
    cwd,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", COLUMNS: String(cols || 80), LINES: String(rows || 24) },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const dataCallbacks = [];
  const exitCallbacks = [];

  proc.stdout.on("data", (chunk) => {
    const str = chunk.toString("utf-8");
    dataCallbacks.forEach((cb) => cb(str));
  });
  proc.stderr.on("data", (chunk) => {
    const str = chunk.toString("utf-8");
    dataCallbacks.forEach((cb) => cb(str));
  });
  proc.on("exit", () => {
    exitCallbacks.forEach((cb) => cb());
  });

  return {
    onData: (cb) => dataCallbacks.push(cb),
    onExit: (cb) => exitCallbacks.push(cb),
    write: (data) => { try { proc.stdin.write(data); } catch {} },
    resize: () => {},
    kill: () => { try { proc.kill(); } catch {} },
  };
}

const SCROLLBACK_LIMIT = 100_000; // chars to keep for reconnection

function appendScrollback(session, data) {
  session.scrollback += data;
  if (session.scrollback.length > SCROLLBACK_LIMIT) {
    session.scrollback = session.scrollback.slice(-SCROLLBACK_LIMIT);
  }
}

function broadcastToSubscribers(session, message) {
  const json = JSON.stringify(message);
  // Snapshot to avoid issues if Set is modified during iteration (e.g. ws.close)
  for (const sub of [...session.subscribers]) {
    if (sub.readyState === sub.OPEN) {
      try { sub.send(json); } catch {}
    }
  }
}

// Strip ANSI escape sequences (CSI, OSC, single-char) so prompt detection sees
// the plain text the user reads, not the cursor-movement/color noise around it.
function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC ... BEL / ST
    .replace(/\x1b[\[\]][0-9;?]*[ -\/]*[@-~]/g, "")     // CSI sequences
    .replace(/\x1b[=>NOM]/g, "");                        // misc single-char
}

// Look at the recent output tail and decide whether it's sitting on an
// interactive prompt the user is expected to answer. Returns:
//   "enter" — a numbered confirmation menu (Claude Code / codex: "❯ 1. Yes …")
//             where the safe default is already highlighted, so pressing Enter
//             accepts it.
//   "yes"   — a classic "(y/n)" style prompt that wants a literal "y".
//   null    — not a prompt (so we never type into the middle of normal output,
//             which was the "へんなところでy" stray-keystroke bug).
function detectPrompt(tail) {
  const s = stripAnsi(tail);
  const tailEnd = s.slice(-800); // only the live region near the cursor
  // Claude Code / codex numbered permission menu — option 1 is the affirmative.
  if (/(?:❯|›|▶|»|>)\s*1[\.\)]\s*(?:Yes|はい|Allow|Proceed|Accept)/i.test(tailEnd)) {
    return "enter";
  }
  // Classic yes/no prompt must be at the very end (the active question line).
  const trimmed = s.replace(/[\s ]+$/, "");
  if (/(?:\(y\/n\)|\(Y\/n\)|\[Y\/n\]|\[y\/N\]|\(yes\/no\))[\s:>?\.]*$/i.test(trimmed)) {
    return "yes";
  }
  return null;
}

// Single place that handles PTY output for every session (fresh, restored, or
// resumed-from-history): persist scrollback, fan out to viewers, flag prompts
// for the sidebar badge, and — when this tab has auto-answer turned ON — accept
// the prompt automatically (the user's goal: not having to press Yes on every
// confirmation).
//
// The old version misfired: it matched "(y/n)" ANYWHERE in a chunk, so it typed
// "y" into the middle of normal output. The fix: only react when a real prompt
// is sitting at the END of the recent output, and use `promptArmed` to respond
// exactly ONCE per prompt — menu redraws/spinners don't trigger repeat keys.
// For a numbered menu we send Enter (accepts the highlighted default = Yes);
// for a classic "(y/n)" prompt we send "y".
function handlePtyOutput(session, data) {
  appendScrollback(session, data);
  broadcastToSubscribers(session, { type: "pty_output", id: session.id, data });

  session.tail = ((session.tail || "") + data).slice(-4000);
  const prompt = detectPrompt(session.tail);

  if (!prompt) {
    session.promptArmed = true; // saw normal output → ready for the next prompt
    return;
  }
  if (session.promptArmed === false) return; // already handled this prompt
  session.promptArmed = false;

  broadcastToSubscribers(session, { type: "session_question", id: session.id });
  if (session.autoYes) {
    session.lastAutoYes = Date.now();
    try { session.proc.write(prompt === "enter" ? "\r" : "y\r"); } catch {}
  }
}

// A Tailscale device gets an IP in the 100.64.0.0/10 CGNAT range and a MagicDNS
// name ending in ".ts.net". Connections from there are members of the operator's
// own private tailnet (Tailscale itself is the auth layer), so we trust them —
// this is what lets the operator open a staff member's hub to help/fix it.
function isTailscaleHost(host) {
  if (host.endsWith(".ts.net")) return true;
  const m = /^100\.(\d+)\./.exec(host);
  if (m) {
    const second = parseInt(m[1], 10);
    return second >= 64 && second <= 127; // 100.64.0.0 – 100.127.255.255
  }
  return false;
}

// Only accept WebSocket connections from the local app itself or from the same
// private Tailscale network. This blocks a malicious website (e.g. via
// DNS-rebinding) and random LAN devices from quietly connecting to the local
// server and spawning shells. Native (Tauri) and curl send no Origin.
function isAllowedOrigin(origin) {
  if (!origin) return true; // native webview / non-browser clients
  try {
    const host = new URL(origin).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") return true;
    return isTailscaleHost(host);
  } catch {
    return false;
  }
}

wss.on("connection", (ws, req) => {
  if (!isAllowedOrigin(req.headers.origin)) {
    console.warn(`Rejected WebSocket from origin: ${req.headers.origin}`);
    try { ws.close(1008, "Forbidden origin"); } catch {}
    return;
  }
  // Heartbeat: a browser tab whose laptop slept or whose Wi-Fi blipped can leave
  // the socket "half-open" — TCP is dead but no close frame ever arrives, so the
  // session pane just freezes. Mark each socket alive on any sign of life and let
  // the periodic sweep terminate the ones that went quiet (see HEARTBEAT below).
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });

  ws.on("message", (raw) => {
    ws.isAlive = true; // any inbound message proves the socket is still live
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "pong") return; // client's reply to our app-level ping

    switch (msg.type) {
      case "create_session": {
        const id = randomUUID();
        const name = (msg.name || `Session ${sessions.size + 1}`).slice(0, 256);
        const cwd = msg.working_dir || homedir();
        const sessionType = msg.session_type || "claude";

        const plat = platform();
        const userShell = plat === "win32" ? (process.env.COMSPEC || "cmd.exe") : (process.env.SHELL || "/bin/bash");
        let shell, args;
        shell = userShell;
        args = plat === "win32" ? [] : ["-l"];

        let proc;
        try {
          proc = createPtySession(shell, args, cwd, msg.cols, msg.rows);
        } catch (e) {
          ws.send(JSON.stringify({ type: "session_error", error: `Failed to start session: ${e.message}` }));
          break;
        }

        const session = { id, name, proc, status: "running", cwd, sessionType, subscribers: new Set([ws]), scrollback: "", autoYes: false };
        sessions.set(id, session);

        // PTY output: broadcast to all subscribers + save scrollback
        proc.onData((data) => handlePtyOutput(session, data));

        proc.onExit(() => {
          session.status = "exited";
          broadcastToSubscribers(session, { type: "session_exited", id });
        });

        // For agent sessions, launch the CLI once the shell is ready.
        // claude -> `claude --session-id <uuid>`, chatgpt -> OpenAI's `codex`.
        // We MINT the Claude session id ourselves and pass it with --session-id,
        // instead of guessing it afterwards by diffing the transcript folder.
        // That old guess routinely failed (esp. several sessions sharing one
        // cwd), leaving claudeSessionId null so a relaunch started Claude blank
        // and the conversation was lost. Owning the id means we know it the
        // instant the tab is created and can persist it immediately, so the
        // exact conversation always comes back.
        // New sessions launch with ALL permission/approval prompts auto-granted,
        // so you never get stopped to confirm edits or commands.
        //   Claude → --dangerously-skip-permissions (bypass all permission checks)
        //   codex  → --dangerously-bypass-approvals-and-sandbox (no prompts, full access)
        let agentCmd = null;
        if (sessionType === "claude") {
          session.claudeSessionId = randomUUID();
          agentCmd = `claude --session-id ${session.claudeSessionId} --dangerously-skip-permissions`;
        } else if (sessionType === "chatgpt") {
          agentCmd = "codex --dangerously-bypass-approvals-and-sandbox";
        }
        if (agentCmd) {
          setTimeout(() => {
            proc.write(`${agentCmd}\n`);
          }, 500);
        }

        ws.send(JSON.stringify({
          type: "session_created",
          session: { id, name, status: "running", working_dir: cwd, session_type: sessionType },
        }));
        saveSessionsToDisk();
        break;
      }

      case "attach_session": {
        const s = sessions.get(msg.id);
        if (s) {
          const alreadySubscribed = s.subscribers.has(ws);
          s.subscribers.add(ws);
          // Send scrollback only on first attach (prevent duplicate output)
          if (!alreadySubscribed && s.scrollback) {
            ws.send(JSON.stringify({ type: "pty_output", id: msg.id, data: s.scrollback }));
          }
          // Tell the client the current auto-Yes state so the toggle reflects
          // reality (e.g. shows green) after a reload/reconnect.
          ws.send(JSON.stringify({ type: "auto_yes_state", id: msg.id, enabled: !!s.autoYes }));
        }
        break;
      }

      case "write": {
        if (typeof msg.data !== "string") break;
        const s = sessions.get(msg.id);
        if (s && s.status === "running") s.proc.write(msg.data);
        break;
      }

      case "resize": {
        const cols = Number.isFinite(msg.cols) && msg.cols > 0 ? Math.min(Math.floor(msg.cols), 500) : 80;
        const rows = Number.isFinite(msg.rows) && msg.rows > 0 ? Math.min(Math.floor(msg.rows), 200) : 24;
        const s = sessions.get(msg.id);
        if (s && s.status === "running") s.proc.resize(cols, rows);
        break;
      }

      case "close_session": {
        const s = sessions.get(msg.id);
        if (s) {
          s.proc.kill();
          // Notify all subscribers before removing
          broadcastToSubscribers(s, { type: "session_closed", id: msg.id });
          sessions.delete(msg.id);
          deleteScrollbackFromDisk(msg.id);
          saveSessionsToDisk();
        }
        break;
      }

      case "clear_scrollback": {
        // "全部軽くする": shrink the saved output so memory/disk shrink. The live
        // PTY process and the AI conversation itself are untouched. keepTail
        // keeps the most recent output so the restored screen isn't blank.
        const s = sessions.get(msg.id);
        if (s) {
          s.scrollback = msg.keepTail ? s.scrollback.slice(-10000) : "";
          writeScrollbackToDisk(s);
        }
        break;
      }

      case "rename_session": {
        if (typeof msg.name !== "string" || !msg.name.trim()) break;
        const newName = msg.name.trim().slice(0, 256);
        const s = sessions.get(msg.id);
        if (s) {
          s.name = newName;
          broadcastToSubscribers(s, { type: "session_renamed", id: msg.id, name: newName });
          saveSessionsToDisk();
        }
        break;
      }

      case "pick_files": {
        let paths = [];
        const plat = platform();
        const isWsl = (() => {
          try { return readFileSync("/proc/version", "utf-8").toLowerCase().includes("microsoft"); } catch { return false; }
        })();

        try {
          if (isWsl) {
            const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.OpenFileDialog
$f.Multiselect = $true
if($f.ShowDialog() -eq 'OK'){
  $joined = $f.FileNames -join '|'
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($joined)
  [Convert]::ToBase64String($bytes)
}`;
            const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", psScript], { encoding: "utf-8", timeout: 60000 });
            const b64 = (result.stdout || "").trim();
            if (b64) {
              const decoded = Buffer.from(b64, "base64").toString("utf-8");
              paths = decoded.split("|").filter(Boolean).map((p) => {
                const r = spawnSync("wslpath", ["-u", p.trim()], { encoding: "utf-8" });
                return r.status === 0 ? r.stdout.trim() : p.trim();
              });
            }
          } else if (plat === "darwin") {
            const script = `
ObjC.import('AppKit');
var panel = $.NSOpenPanel.openPanel;
panel.canChooseFiles = true;
panel.canChooseDirectories = true;
panel.allowsMultipleSelection = true;
var result = panel.runModal;
var paths = [];
if (result === $.NSModalResponseOK) {
    var urls = panel.URLs;
    for (var i = 0; i < urls.count; i++) {
        paths.push(urls.objectAtIndex(i).path.js);
    }
}
paths.join('|');`;
            const result = spawnSync("osascript", ["-l", "JavaScript", "-e", script], { encoding: "utf-8", timeout: 60000 });
            if (result.stdout) paths = result.stdout.trim().split("|").filter(Boolean);
          } else {
            const result = spawnSync("zenity", ["--file-selection", "--multiple", "--separator=|"], { encoding: "utf-8", timeout: 60000 });
            if (result.stdout) paths = result.stdout.trim().split("|").filter(Boolean);
          }
        } catch {}
        ws.send(JSON.stringify({ type: "files_picked", paths, sessionId: msg.sessionId }));
        break;
      }

      case "upload_file": {
        if (typeof msg.data !== "string") break;
        // Base64 string ~133% of original size; 134MB base64 ≈ 100MB file
        if (msg.data.length > 134_000_000) {
          ws.send(JSON.stringify({ type: "file_upload_error", error: "File too large (max 100MB)" }));
          break;
        }
        const uploadDir = join(tmpdir(), "ibis-hub-uploads");
        try { mkdirSync(uploadDir, { recursive: true }); } catch {}
        const safeName = (msg.name || "file").replace(/[\/\\]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
        const filePath = join(uploadDir, `${randomUUID()}_${safeName}`);
        try {
          writeFileSync(filePath, Buffer.from(msg.data, "base64"));
          ws.send(JSON.stringify({ type: "file_uploaded", path: filePath, sessionId: msg.sessionId }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "file_upload_error", error: "File upload failed" }));
        }
        break;
      }

      case "list_sessions": {
        const list = Array.from(sessions.values()).map((s) => ({
          id: s.id, name: s.name, status: s.status, working_dir: s.cwd, session_type: s.sessionType, auto_yes: !!s.autoYes,
        }));
        ws.send(JSON.stringify({ type: "session_list", sessions: list }));
        break;
      }

      case "set_auto_yes": {
        // Per-tab toggle: when on, this session auto-answers y/n prompts itself.
        const s = sessions.get(msg.id);
        if (s) {
          s.autoYes = !!msg.enabled;
          broadcastToSubscribers(s, { type: "auto_yes_state", id: msg.id, enabled: s.autoYes });
          saveSessionsToDisk(); // remember the toggle across restarts
        }
        break;
      }

      case "list_conversations": {
        const cwd = msg.cwd || homedir();
        // Hide ids currently live in a tab — those are "open", not "past".
        const live = new Set(
          Array.from(sessions.values())
            .filter((s) => s.cwd === cwd && s.claudeSessionId)
            .map((s) => s.claudeSessionId),
        );
        const conversations = listConversations(cwd).filter((c) => !live.has(c.id));
        ws.send(JSON.stringify({ type: "conversation_list", cwd, conversations }));
        break;
      }

      case "delete_conversation": {
        // Soft-delete: move the transcript into a trash folder so it can be
        // recovered, rather than destroying the conversation outright.
        const cwd = msg.cwd || homedir();
        if (!UUID_RE.test(String(msg.id || ""))) {
          ws.send(JSON.stringify({ type: "conversation_delete_error", id: msg.id, error: "bad id" }));
          break;
        }
        const dir = claudeProjectDir(cwd);
        const src = join(dir, `${msg.id}.jsonl`);
        try {
          const trash = join(dir, ".ibishub-trash");
          mkdirSync(trash, { recursive: true });
          renameSync(src, join(trash, `${msg.id}.jsonl`));
          ws.send(JSON.stringify({ type: "conversation_deleted", id: msg.id }));
        } catch (e) {
          ws.send(JSON.stringify({ type: "conversation_delete_error", id: msg.id, error: e.message }));
        }
        break;
      }

      case "resume_conversation": {
        // Open a past conversation in a brand-new tab (so it never fights with a
        // claude already running in another tab). The tab owns this id, so it is
        // durable from here on, exactly like a fresh session.
        const cwd = msg.cwd || homedir();
        if (!UUID_RE.test(String(msg.id || ""))) break;
        const id = randomUUID();
        const name = (msg.name || "過去のチャット").slice(0, 256);
        const plat = platform();
        const userShell = plat === "win32" ? (process.env.COMSPEC || "cmd.exe") : (process.env.SHELL || "/bin/bash");
        const args = plat === "win32" ? [] : ["-l"];
        let proc;
        try {
          proc = createPtySession(userShell, args, cwd, msg.cols, msg.rows);
        } catch (e) {
          ws.send(JSON.stringify({ type: "session_error", error: `Failed to start session: ${e.message}` }));
          break;
        }
        const session = { id, name, proc, status: "running", cwd, sessionType: "claude", subscribers: new Set([ws]), scrollback: "", claudeSessionId: msg.id, autoYes: false };
        sessions.set(id, session);
        proc.onData((data) => handlePtyOutput(session, data));
        proc.onExit(() => {
          session.status = "exited";
          broadcastToSubscribers(session, { type: "session_exited", id });
        });
        setTimeout(() => { proc.write(`claude --resume ${msg.id} --dangerously-skip-permissions\n`); }, 500);
        ws.send(JSON.stringify({
          type: "session_created",
          session: { id, name, status: "running", working_dir: cwd, session_type: "claude" },
        }));
        saveSessionsToDisk();
        break;
      }
    }
  });

  ws.on("close", () => {
    // Don't kill sessions — just remove this ws from all session subscribers
    for (const [id, session] of sessions) {
      session.subscribers.delete(ws);
    }
  });
});

// Heartbeat sweep: every 25s, drop sockets that never answered last round and
// ping the rest. We send BOTH a protocol-level ping (cleans up dead sockets
// server-side) and an app-level {type:"ping"} the browser can see (so the
// client's own watchdog can notice silence and reconnect — browsers don't
// expose protocol pongs to JS).
const HEARTBEAT_MS = 25000;
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
    try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
  }
}, HEARTBEAT_MS);
heartbeat.unref();
wss.on("close", () => clearInterval(heartbeat));

httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Kill the existing process or use a different PORT.`);
  } else {
    console.error("Server error:", err.message);
  }
  process.exit(1);
});

httpServer.listen(PORT, () => {
  console.log(`Ibis Hub running at http://localhost:${PORT}`);

  // Restore sessions from previous run
  const saved = restoreSessionsFromDisk();
  if (saved.length > 0) {
    console.log(`Restoring ${saved.length} session(s) from previous run...`);
    for (const s of saved) {
      const cwd = s.cwd || homedir();
      const sessionType = s.sessionType || "shell";
      const plat = platform();
      const userShell = plat === "win32" ? (process.env.COMSPEC || "cmd.exe") : (process.env.SHELL || "/bin/bash");
      const args = plat === "win32" ? [] : ["-l"];

      try {
        const proc = createPtySession(userShell, args, cwd, 80, 24);
        // Preload the previous on-screen output so the restored pane shows
        // history instead of being blank until new output arrives.
        const session = { id: s.id, name: s.name, proc, status: "running", cwd, sessionType, subscribers: new Set(), scrollback: readScrollbackFromDisk(s.id), claudeSessionId: s.claudeSessionId || null, autoYes: s.autoYes === true };
        sessions.set(s.id, session);

        proc.onData((data) => handlePtyOutput(session, data));

        proc.onExit(() => {
          session.status = "exited";
          broadcastToSubscribers(session, { type: "session_exited", id: s.id });
        });

        // On RESTORE (unlike a fresh create_session), resume the previous
        // conversation instead of starting a new one, so the user picks up
        // where they left off after killing/relaunching Ibis Hub.
        //   claude -> `claude --resume <id>` ONLY when we have a unique captured
        //             id (claim it so no other session reuses it). Otherwise a
        //             FRESH `claude` — never `--continue`, which resumes the
        //             folder's newest convo and would merge same-folder sessions.
        //   codex  -> `codex resume --last`
        let restoreAgentCmd = null;
        if (sessionType === "claude") {
          let cid = s.claudeSessionId;
          // Apply the one-time recovery remap and persist the corrected id so the
          // tab is permanently linked to its real conversation from here on.
          if (cid && CLAUDE_ID_RECOVERY[cid]) {
            cid = CLAUDE_ID_RECOVERY[cid];
            session.claudeSessionId = cid;
          }
          if (cid && !claimedClaudeIds.has(cid)) {
            claimedClaudeIds.add(cid);
            // Resume the exact conversation by its id. If the user never sent a
            // first message last run, no transcript exists yet — reopen the SAME
            // id fresh (--resume would fail on a missing transcript).
            restoreAgentCmd = claudeTranscriptExists(cwd, cid)
              ? `claude --resume ${cid}`
              : `claude --session-id ${cid}`;
          } else {
            // Legacy tab from before self-assigned ids (claudeSessionId null) —
            // don't trap the user in Claude's resume picker. Start a fresh chat
            // and assign it a durable id NOW, so from here on this tab always
            // comes back to its own conversation. (Old conversations are still on
            // disk and can be reopened later with `claude --resume`.)
            session.claudeSessionId = randomUUID();
            restoreAgentCmd = `claude --session-id ${session.claudeSessionId}`;
          }
        } else if (sessionType === "chatgpt") {
          restoreAgentCmd = "codex --dangerously-bypass-approvals-and-sandbox resume --last";
        }
        // Auto-grant all permission/approval prompts on restore too (matches a
        // fresh session). The codex flag is already baked into its command above.
        if (sessionType === "claude" && restoreAgentCmd) {
          restoreAgentCmd += " --dangerously-skip-permissions";
        }
        if (restoreAgentCmd) {
          setTimeout(() => { proc.write(`${restoreAgentCmd}\n`); }, 500);
        }

        console.log(`  Restored: ${s.name} (${sessionType})`);
      } catch (e) {
        console.error(`  Failed to restore ${s.name}: ${e.message}`);
      }
    }
    // Persist any ids freshly assigned to legacy tabs during restore, so the
    // NEXT relaunch resumes them instead of starting blank again.
    saveSessionsToDisk();
  }
});

// Capture the transcript id of any Claude session that has one but hasn't been
// recorded yet (Claude writes the file only after the user's first message).
// Once recorded + saved, a relaunch resumes that exact conversation, so both
// the tab AND its contents come back. Returns true if anything was captured.
function captureMissingClaudeIds() {
  let changed = false;
  for (const [, session] of sessions) {
    if (
      session.sessionType === "claude" &&
      !session.claudeSessionId &&
      session.claudeBeforeIds &&
      session.status === "running"
    ) {
      const cid = captureNewClaudeSessionId(session.cwd, session.claudeBeforeIds);
      if (cid) {
        session.claudeSessionId = cid;
        changed = true;
      }
    }
  }
  return changed;
}

// Periodically persist scrollback so a crash / force-quit still leaves a
// recent screen to restore (the graceful path below also flushes on exit),
// and lazily capture Claude transcript ids as their files appear.
setInterval(() => {
  for (const [, session] of sessions) writeScrollbackToDisk(session);
  if (captureMissingClaudeIds()) saveSessionsToDisk();
}, 5000).unref();

// Graceful shutdown — kill all PTY processes on server exit
function shutdown() {
  console.log("\nShutting down — saving sessions and killing PTYs...");
  captureMissingClaudeIds(); // last chance to link any just-started conversation
  saveSessionsToDisk();
  for (const [id, session] of sessions) {
    writeScrollbackToDisk(session);
    try { session.proc.kill(); } catch {}
  }
  sessions.clear();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
