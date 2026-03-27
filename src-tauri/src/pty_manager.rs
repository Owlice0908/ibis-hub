use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    pub status: String,
    pub working_dir: String,
    pub session_type: String,
}

struct Session {
    info: SessionInfo,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    _child: Box<dyn portable_pty::Child + Send>,
    stop_flag: Arc<AtomicBool>,
}

pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
    app_handle: AppHandle,
}

impl PtyManager {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            app_handle,
        }
    }

    pub fn create_session(
        &self,
        name: String,
        working_dir: Option<String>,
        session_type: String,
    ) -> Result<SessionInfo, String> {
        let pty_system = native_pty_system();
        let size = PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        };

        let pair = pty_system
            .openpty(size)
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        let cwd = working_dir.clone().unwrap_or_else(|| {
            std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
        });

        // Build command with environment matching Windows Terminal
        let cmd = if session_type == "claude" {
            let claude_path = which_claude().unwrap_or_else(|| "claude".to_string());
            let mut c = CommandBuilder::new(&claude_path);
            c.cwd(&cwd);
            for (key, value) in std::env::vars() {
                c.env(key, value);
            }
            // Ensure terminal environment matches Windows Terminal
            c.env("TERM", "xterm-256color");
            c.env("LANG", "C.UTF-8");
            c.env("LC_ALL", "C.UTF-8");
            c.env("COLORTERM", "truecolor");
            c
        } else {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
            let mut c = CommandBuilder::new(&shell);
            c.args(["-l"]);
            c.cwd(&cwd);
            for (key, value) in std::env::vars() {
                c.env(key, value);
            }
            c.env("TERM", "xterm-256color");
            c.env("LANG", "C.UTF-8");
            c.env("LC_ALL", "C.UTF-8");
            c.env("COLORTERM", "truecolor");
            c
        };

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn: {}", e))?;

        let id = Uuid::new_v4().to_string();
        let info = SessionInfo {
            id: id.clone(),
            name,
            status: "running".to_string(),
            working_dir: cwd,
            session_type,
        };

        // Get reader and writer up front
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone reader: {}", e))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to get writer: {}", e))?;

        let event_name = format!("pty-output-{}", id);
        let app = self.app_handle.clone();
        let session_id = id.clone();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop_flag_clone = stop_flag.clone();

        std::thread::spawn(move || {
            Self::read_pty_output(reader, app, event_name, session_id, stop_flag_clone);
        });

        let session = Session {
            info: info.clone(),
            master: pair.master,
            writer,
            _child: child,
            stop_flag,
        };

        self.sessions.lock().insert(id, session);
        Ok(info)
    }

    fn read_pty_output(
        mut reader: Box<dyn Read + Send>,
        app: AppHandle,
        event_name: String,
        session_id: String,
        stop_flag: Arc<AtomicBool>,
    ) {
        let mut buf = [0u8; 4096];
        let mut leftover = Vec::new();
        loop {
            if stop_flag.load(Ordering::Relaxed) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = app.emit(&format!("session-exited-{}", session_id), ());
                    break;
                }
                Ok(n) => {
                    // Prepend any leftover bytes from a previous incomplete UTF-8 sequence
                    let chunk = if leftover.is_empty() {
                        &buf[..n]
                    } else {
                        leftover.extend_from_slice(&buf[..n]);
                        leftover.as_slice()
                    };

                    // Find the last valid UTF-8 boundary
                    let valid_up_to = match std::str::from_utf8(chunk) {
                        Ok(_) => chunk.len(),
                        Err(e) => e.valid_up_to(),
                    };

                    let data = if valid_up_to > 0 {
                        // Safety: we just verified this range is valid UTF-8
                        unsafe { std::str::from_utf8_unchecked(&chunk[..valid_up_to]) }.to_string()
                    } else {
                        String::new()
                    };

                    // Save incomplete trailing bytes for next read (cap to prevent unbounded growth)
                    let remaining = &chunk[valid_up_to..];
                    if remaining.len() > 16 {
                        // More than 16 bytes of invalid UTF-8 — discard to prevent memory leak
                        leftover.clear();
                    } else {
                        leftover = remaining.to_vec();
                    }

                    if !data.is_empty() {
                        let _ = app.emit(&event_name, &data);

                        // Lightweight question detection
                        if data.contains("(y/n)")
                            || data.contains("(Y/n)")
                            || data.contains("[Y/n]")
                            || data.contains("[y/N]")
                        {
                            let question_event = format!("session-question-{}", session_id);
                            let _ = app.emit(&question_event, ());
                        }
                    }
                }
                Err(_) => {
                    let _ = app.emit(&format!("session-exited-{}", session_id), ());
                    break;
                }
            }
        }
    }

    pub fn list_sessions(&self) -> Vec<SessionInfo> {
        self.sessions
            .lock()
            .values()
            .map(|s| s.info.clone())
            .collect()
    }

    pub fn write_to_session(&self, id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock();
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| "Session not found".to_string())?;
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Write failed: {}", e))?;
        session
            .writer
            .flush()
            .map_err(|e| format!("Flush failed: {}", e))?;
        Ok(())
    }

    pub fn resize_session(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock();
        let session = sessions
            .get(id)
            .ok_or_else(|| "Session not found".to_string())?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Resize failed: {}", e))?;
        Ok(())
    }

    pub fn close_session(&self, id: &str) -> Result<(), String> {
        let session = self.sessions
            .lock()
            .remove(id)
            .ok_or_else(|| "Session not found".to_string())?;
        // Signal the reader thread to stop
        session.stop_flag.store(true, Ordering::Relaxed);
        Ok(())
    }

    pub fn rename_session(&self, id: &str, name: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock();
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| "Session not found".to_string())?;
        session.info.name = name.to_string();
        Ok(())
    }
}

/// Find the claude binary by checking PATH and common install locations
fn which_claude() -> Option<String> {
    // Try PATH lookup (platform-aware)
    let which_cmd = if cfg!(target_os = "windows") { "where" } else { "which" };
    if let Ok(output) = std::process::Command::new(which_cmd).arg("claude").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();

    // Check common locations (Unix + Mac + Windows)
    let candidates = [
        format!("{}/.npm-global/bin/claude", home),
        "/usr/local/bin/claude".to_string(),
        "/opt/homebrew/bin/claude".to_string(),             // Mac Apple Silicon
        format!("{}/AppData/Roaming/npm/claude.cmd", home), // Windows npm global
        format!("{}/AppData/Roaming/npm/claude", home),     // Windows npm global (no ext)
    ];

    for candidate in &candidates {
        if std::path::Path::new(&candidate).exists() {
            return Some(candidate.clone());
        }
    }

    // Try NVM paths by scanning the directory
    let nvm_dir = format!("{}/.nvm/versions/node", home);
    if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
        for entry in entries.flatten() {
            let claude_path = entry.path().join("bin/claude");
            if claude_path.exists() {
                return Some(claude_path.to_string_lossy().to_string());
            }
        }
    }

    None
}
