mod pty_manager;

use pty_manager::{PtyManager, SessionInfo};
use std::sync::Arc;
use tauri::{Manager, State};

type PtyState = Arc<PtyManager>;

#[tauri::command]
fn create_session(
    state: State<'_, PtyState>,
    name: String,
    working_dir: Option<String>,
    session_type: Option<String>,
) -> Result<SessionInfo, String> {
    let stype = session_type.unwrap_or_else(|| "shell".to_string());
    state.create_session(name, working_dir, stype)
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

/// macOS file picker using osascript (bypasses WebView completely)
#[tauri::command]
fn pick_files_macos() -> Result<Vec<String>, String> {
    let script = r#"
set fileList to choose file with multiple selections allowed
set posixPaths to ""
repeat with f in fileList
    set posixPaths to posixPaths & POSIX path of f & linefeed
end repeat
return posixPaths
"#;
    let output = std::process::Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| format!("osascript failed: {}", e))?;

    if !output.status.success() {
        // User cancelled or error
        return Ok(vec![]);
    }

    let paths: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    Ok(paths)
}

/// WSL-specific file picker using Windows native dialog via PowerShell
#[tauri::command]
fn pick_files_wsl() -> Result<Vec<String>, String> {
    let ps_script = r#"
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.OpenFileDialog
$f.Multiselect = $true
if($f.ShowDialog() -eq 'OK'){
    $joined = $f.FileNames -join '|'
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($joined)
    [Convert]::ToBase64String($bytes)
}
"#;
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", ps_script])
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
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
            upload_file,
            pick_files_macos,
            pick_files_wsl,
            toggle_ime,
            get_ime_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
