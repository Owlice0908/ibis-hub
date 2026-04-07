import { WebSocketServer } from "ws";
import { createServer } from "http";
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { homedir, tmpdir, platform } from "os";
import { execSync, spawnSync, spawn } from "child_process";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DIST_DIR = join(__dirname, "dist");
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
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

const httpServer = createServer((req, res) => {
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

wss.on("connection", (ws) => {
  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;

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

        const session = { id, name, proc, status: "running", cwd, sessionType, subscribers: new Set([ws]), scrollback: "" };
        sessions.set(id, session);

        // PTY output: broadcast to all subscribers + save scrollback
        proc.onData((data) => {
          appendScrollback(session, data);
          broadcastToSubscribers(session, { type: "pty_output", id, data });

          if (data.includes("(y/n)") || data.includes("(Y/n)") || data.includes("[Y/n]") || data.includes("[y/N]")) {
            broadcastToSubscribers(session, { type: "session_question", id });
          }
        });

        proc.onExit(() => {
          session.status = "exited";
          broadcastToSubscribers(session, { type: "session_exited", id });
        });

        // For claude sessions, send "claude" command after shell is ready
        if (sessionType === "claude") {
          setTimeout(() => {
            proc.write("claude\n");
          }, 500);
        }

        ws.send(JSON.stringify({
          type: "session_created",
          session: { id, name, status: "running", working_dir: cwd, session_type: sessionType },
        }));
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
          id: s.id, name: s.name, status: s.status, working_dir: s.cwd, session_type: s.sessionType,
        }));
        ws.send(JSON.stringify({ type: "session_list", sessions: list }));
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
});

// Graceful shutdown — kill all PTY processes on server exit
function shutdown() {
  console.log("\nShutting down — killing all sessions...");
  for (const [id, session] of sessions) {
    try { session.proc.kill(); } catch {}
  }
  sessions.clear();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
