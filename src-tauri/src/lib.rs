mod pty_manager;

use pty_manager::{PtyManager, SessionInfo};
use std::sync::Arc;
use std::io::Write;
use tauri::{Manager, State};

type PtyState = Arc<PtyManager>;

/// Write a log message to ~/ibis-hub.log
fn log(msg: &str) {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/tmp".to_string());
    let log_path = std::path::PathBuf::from(&home).join("ibis-hub.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let _ = writeln!(f, "[{}] {}", now, msg);
    }
}

/// Frontend-callable log command (for debugging D&D, etc.)
#[tauri::command]
fn log_frontend(message: String) {
    log(&format!("[frontend] {}", message));
}

/// Get the log file path
#[tauri::command]
fn get_log_path() -> String {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/tmp".to_string());
    std::path::PathBuf::from(&home).join("ibis-hub.log").to_string_lossy().to_string()
}

#[tauri::command]
fn create_session(
    state: State<'_, PtyState>,
    name: String,
    working_dir: Option<String>,
    session_type: Option<String>,
) -> Result<SessionInfo, String> {
    let stype = session_type.unwrap_or_else(|| "shell".to_string());
    log(&format!("create_session: name={}, type={}, cwd={:?}", name, stype, working_dir));
    let result = state.create_session(name, working_dir, stype);
    match &result {
        Ok(info) => log(&format!("create_session OK: id={}", info.id)),
        Err(e) => log(&format!("create_session ERROR: {}", e)),
    }
    result
}

#[tauri::command]
fn list_sessions(state: State<'_, PtyState>) -> Vec<SessionInfo> {
    state.list_sessions()
}

#[tauri::command]
fn write_to_session(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    state.write_to_session(&id, &data)
}

#[tauri::command]
fn resize_session(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize_session(&id, cols, rows)
}

#[tauri::command]
fn close_session(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    state.close_session(&id)
}

#[tauri::command]
fn rename_session(state: State<'_, PtyState>, id: String, name: String) -> Result<(), String> {
    state.rename_session(&id, &name)
}

/// Check if running inside WSL
fn is_wsl() -> bool {
    std::fs::read_to_string("/proc/version")
        .map(|v| v.to_lowercase().contains("microsoft"))
        .unwrap_or(false)
}

#[tauri::command]
fn get_platform() -> String {
    if is_wsl() {
        "wsl".to_string()
    } else {
        std::env::consts::OS.to_string()
    }
}

/// Toggle fcitx5 IME (e.g. Mozc) and return whether it's now active
#[tauri::command]
fn toggle_ime() -> Result<bool, String> {
    let output = std::process::Command::new("fcitx5-remote")
        .arg("-t")
        .output()
        .map_err(|e| format!("fcitx5-remote failed: {}", e))?;
    if !output.status.success() {
        return Err("fcitx5-remote toggle failed".to_string());
    }
    // Check new state: 1=inactive, 2=active
    let state_output = std::process::Command::new("fcitx5-remote")
        .output()
        .map_err(|e| format!("fcitx5-remote failed: {}", e))?;
    let state_str = String::from_utf8_lossy(&state_output.stdout).trim().to_string();
    Ok(state_str == "2")
}

/// Get current IME state: true if active (Japanese), false if inactive (English)
#[tauri::command]
fn get_ime_state() -> bool {
    std::process::Command::new("fcitx5-remote")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "2")
        .unwrap_or(false)
}

/// Save a dropped/uploaded file to a temp directory and return the path
#[tauri::command]
fn upload_file(name: String, data: String) -> Result<String, String> {
    use base64::Engine;

    let upload_dir = std::env::temp_dir().join("ibis-hub-uploads");
    std::fs::create_dir_all(&upload_dir)
        .map_err(|e| format!("Failed to create upload dir: {}", e))?;

    // Sanitize filename
    let safe_name: String = name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | '\0'))
        .collect();
    let file_name = format!("{}_{}", uuid::Uuid::new_v4(), safe_name);
    let file_path = upload_dir.join(&file_name);

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("Base64 decode failed: {}", e))?;

    std::fs::write(&file_path, bytes)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(file_path.to_string_lossy().to_string())
}

/// macOS file picker using NSOpenPanel directly via objc.
/// canChooseFiles + canChooseDirectories = "Open" selects both files and folders.
///
/// CRITICAL: NSOpenPanel must be called from the main thread on macOS.
/// Tauri sync command handlers run on a worker thread by default, so we
/// dispatch the actual NSOpenPanel call to the main thread via
/// `app.run_on_main_thread()` and wait on a channel. Calling Cocoa APIs
/// from non-main threads is undefined behavior — this caused the picker
/// to "sometimes work, sometimes not".
#[tauri::command]
fn pick_files_macos(_app: tauri::AppHandle) -> Result<Vec<String>, String> {
    log("pick_files_macos: dispatching NSOpenPanel to main thread");
    #[cfg(target_os = "macos")]
    {
        use std::sync::mpsc;
        let (tx, rx) = mpsc::channel::<Result<Vec<String>, String>>();

        _app.run_on_main_thread(move || {
            use objc::{msg_send, sel, sel_impl, class};
            use objc::runtime::Object;
            let result: Result<Vec<String>, String> = unsafe {
                let panel: *mut Object = msg_send![class!(NSOpenPanel), openPanel];
                if panel.is_null() {
                    Err("NSOpenPanel openPanel returned null".to_string())
                } else {
                    let _: () = msg_send![panel, setCanChooseFiles: true];
                    let _: () = msg_send![panel, setCanChooseDirectories: true];
                    let _: () = msg_send![panel, setAllowsMultipleSelection: true];
                    let modal_result: isize = msg_send![panel, runModal];
                    // NSModalResponseOK = 1, NSModalResponseCancel = 0
                    if modal_result != 1 {
                        log("pick_files_macos: cancelled by user");
                        Ok(Vec::new())
                    } else {
                        let urls: *mut Object = msg_send![panel, URLs];
                        let count: usize = msg_send![urls, count];
                        let mut paths = Vec::with_capacity(count);
                        for i in 0..count {
                            let url: *mut Object = msg_send![urls, objectAtIndex: i];
                            let path: *mut Object = msg_send![url, path];
                            let cstr: *const std::os::raw::c_char = msg_send![path, UTF8String];
                            if !cstr.is_null() {
                                let s = std::ffi::CStr::from_ptr(cstr).to_string_lossy().to_string();
                                paths.push(s);
                            }
                        }
                        log(&format!("pick_files_macos: selected {} paths", paths.len()));
                        Ok(paths)
                    }
                }
            };
            let _ = tx.send(result);
        }).map_err(|e| {
            log(&format!("pick_files_macos: run_on_main_thread failed: {}", e));
            format!("run_on_main_thread failed: {}", e)
        })?;

        // Block on worker thread waiting for main-thread result
        match rx.recv() {
            Ok(result) => result,
            Err(e) => {
                log(&format!("pick_files_macos: channel recv failed: {}", e));
                Err(format!("channel recv failed: {}", e))
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Not macOS".to_string())
    }
}

/// WSL-specific file picker using Windows native dialog via PowerShell.
/// Uses CommonOpenFileDialog which allows selecting both files and folders.
#[tauri::command]
fn pick_files_wsl() -> Result<Vec<String>, String> {
    let ps_script = r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName Microsoft.VisualBasic
$f = New-Object System.Windows.Forms.OpenFileDialog
$f.Multiselect = $true
$f.Title = "Select files (or type folder path and press Open)"
if($f.ShowDialog() -eq 'OK'){
    $joined = $f.FileNames -join '|'
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($joined)
    [Convert]::ToBase64String($bytes)
}
"#.to_string();
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", &ps_script])
        .output()
        .map_err(|e| format!("Failed to open file dialog: {}", e))?;

    let b64 = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if b64.is_empty() {
        return Ok(vec![]);
    }

    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&b64)
        .map_err(|e| format!("Base64 decode failed: {}", e))?;
    let result = String::from_utf8(decoded)
        .map_err(|e| format!("UTF-8 decode failed: {}", e))?;

    let paths: Vec<String> = result
        .split('|')
        .filter(|s| !s.is_empty())
        .map(|p| {
            let cleaned = p.trim().replace('\r', "");
            let output = std::process::Command::new("wslpath")
                .arg("-u")
                .arg(&cleaned)
                .output();
            match output {
                Ok(o) if o.status.success() => {
                    String::from_utf8_lossy(&o.stdout).trim().to_string()
                }
                _ => cleaned,
            }
        })
        .collect();
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_log_path_returns_non_empty() {
        let path = get_log_path();
        assert!(!path.is_empty(), "log path must not be empty");
        assert!(path.ends_with("ibis-hub.log"), "log path must end with ibis-hub.log, got: {}", path);
    }

    #[test]
    fn test_get_platform_returns_known_value() {
        let plat = get_platform();
        let valid = ["wsl", "macos", "windows", "linux", "freebsd", "openbsd", "netbsd", "dragonfly", "ios", "android"];
        assert!(
            valid.contains(&plat.as_str()),
            "platform should be a known value, got: {}",
            plat
        );
    }

    #[test]
    fn test_log_does_not_panic() {
        // log() should never panic even if log file is unwritable
        log("test message from unit test");
    }

    #[test]
    fn test_log_frontend_does_not_panic() {
        log_frontend("test message from frontend".to_string());
    }

    #[test]
    fn test_is_wsl_returns_bool() {
        // Just verify it doesn't panic and returns a bool
        let _ = is_wsl();
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn test_pick_files_macos_returns_error_on_non_mac() {
        // On non-macOS platforms, this should return an error string.
        // We can't actually invoke it without an AppHandle, but the cfg
        // ensures it compiles correctly on every platform.
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            log(&format!("=== Ibis Hub started === platform={}, SHELL={:?}, HOME={:?}",
                std::env::consts::OS,
                std::env::var("SHELL").ok(),
                std::env::var("HOME").ok(),
            ));
            let pty_manager = Arc::new(PtyManager::new(app.handle().clone()));
            app.manage(pty_manager);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_session,
            list_sessions,
            write_to_session,
            resize_session,
            close_session,
            rename_session,
            get_platform,
            get_log_path,
            log_frontend,
            upload_file,
            pick_files_macos,
            pick_files_wsl,
            toggle_ime,
            get_ime_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
