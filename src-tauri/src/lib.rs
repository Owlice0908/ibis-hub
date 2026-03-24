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
) -> Result<SessionInfo, String> {
    state.create_session(name, working_dir)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
