// ネイティブ端末モジュールの Tauri command 配線層。
// Frontend からの invoke はここで受け、プラットフォーム別 backend へ委譲する。
//
// 4 つの Tauri command を提供:
//   - spawn_native_terminal       : 新規ペインのターミナル起動
//   - update_native_terminal_rect : ペイン矩形変化の通知(高頻度)
//   - close_native_terminal       : ペイン単独終了
//   - set_native_terminal_visible : 可視状態切替(タブ切替時 hide/show)
//
// アプリ終了時に backend.close_all() を呼ぶのは lib.rs の on_window_event 側。

use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use super::traits::{NativeTerminalBackend, NativeTerminalError, PaneRect, SessionType, SpawnOptions};

/// Tauri の管理状態としてプロセス全体で 1 つ保持する。
pub struct NativeTerminalManager {
    pub backend: Arc<dyn NativeTerminalBackend>,
}

impl NativeTerminalManager {
    pub fn new(backend: Arc<dyn NativeTerminalBackend>) -> Self {
        Self { backend }
    }
}

// Frontend → Rust 4 コマンド ───────────────────────────────────────

#[tauri::command]
pub async fn spawn_native_terminal(
    pane_id: String,
    cwd: Option<String>,
    rect: PaneRect,
    state: State<'_, NativeTerminalManager>,
    app: AppHandle,
) -> Result<(), NativeTerminalError> {
    let opts = SpawnOptions {
        pane_id: pane_id.clone(),
        cwd,
        rect,
        session_type: SessionType::Claude,
    };
    let result = state.backend.spawn(opts);

    // 起動完了/失敗は backend 側でも内部 emit するが、即時失敗はここで返す
    if let Err(ref e) = result {
        let _ = app.emit(
            "native-terminal-error",
            serde_json::json!({ "paneId": pane_id, "error": e.message }),
        );
    }
    result
}

#[tauri::command]
pub async fn update_native_terminal_rect(
    pane_id: String,
    rect: PaneRect,
    state: State<'_, NativeTerminalManager>,
) -> Result<(), NativeTerminalError> {
    state.backend.update_rect(&pane_id, rect)
}

#[tauri::command]
pub async fn close_native_terminal(
    pane_id: String,
    state: State<'_, NativeTerminalManager>,
) -> Result<(), NativeTerminalError> {
    state.backend.close(&pane_id)
}

#[tauri::command]
pub async fn set_native_terminal_visible(
    pane_id: String,
    visible: bool,
    state: State<'_, NativeTerminalManager>,
) -> Result<(), NativeTerminalError> {
    state.backend.set_visible(&pane_id, visible)
}

#[tauri::command]
pub fn native_terminal_available(state: State<'_, NativeTerminalManager>) -> bool {
    state.backend.is_available()
}
