use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
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
    _child: Box<dyn portable_pty::Child + Send>,
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

        let cmd = if session_type == "claude" {
            let mut c = CommandBuilder::new("claude");
            c.cwd(&cwd);
            c
        } else {
            let mut c = CommandBuilder::new("bash");
            c.args(["-l"]);
            c.cwd(&cwd);
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

        // Spawn reader thread to emit PTY output to frontend
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone reader: {}", e))?;
        let event_name = format!("pty-output-{}", id);
        let app = self.app_handle.clone();
        let session_id = id.clone();

        std::thread::spawn(move || {
            Self::read_pty_output(reader, app, event_name, session_id);
        });

        let session = Session {
            info: info.clone(),
            master: pair.master,
            _child: child,
        };

        self.sessions.lock().insert(id, session);
        Ok(info)
    }

    fn read_pty_output(
        mut reader: Box<dyn Read + Send>,
        app: AppHandle,
        event_name: String,
        session_id: String,
    ) {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = app.emit(&format!("session-exited-{}", session_id), ());
                    break;
                }
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit(&event_name, &data);

                    // Detect question patterns and emit notification
                    let lower = data.to_lowercase();
                    let has_question = data.contains("(y/n)")
                        || data.contains("(Y/n)")
                        || data.contains("[Y/n]")
                        || data.contains("[y/N]")
                        || lower.contains("do you want")
                        || lower.contains("would you like")
                        || lower.contains("allow")
                        || lower.contains("approve")
                        || data.lines().any(|line| {
                            let trimmed = line.trim();
                            trimmed.ends_with('?') && trimmed.len() > 2
                        });

                    if has_question {
                        let question_event = format!("session-question-{}", session_id);
                        let _ = app.emit(&question_event, &data);
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
        let mut writer = session
            .master
            .take_writer()
            .map_err(|e| format!("Failed to get writer: {}", e))?;
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Write failed: {}", e))?;
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
        self.sessions
            .lock()
            .remove(id)
            .ok_or_else(|| "Session not found".to_string())?;
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
