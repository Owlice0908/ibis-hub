// プラットフォーム共通の trait と型定義。
// Win/Mac の実装はこの trait を実装する。Frontend からは manager 経由で呼ぶ。

use serde::{Deserialize, Serialize};

// ペインの矩形(Frontend の getBoundingClientRect 由来、論理 CSS px)
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct PaneRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(rename = "scaleFactor")]
    pub scale_factor: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct NativeTerminalError {
    pub kind: ErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    NotSupported,
    SpawnFailed,
    WindowNotFound,
    PermissionDenied,
    AlreadyExists,
    NotFound,
    Platform,
}

impl NativeTerminalError {
    pub fn not_supported() -> Self {
        Self {
            kind: ErrorKind::NotSupported,
            message: "Native terminal overlay is not supported on this platform".to_string(),
        }
    }
    pub fn spawn_failed(msg: impl Into<String>) -> Self {
        Self { kind: ErrorKind::SpawnFailed, message: msg.into() }
    }
    pub fn window_not_found(msg: impl Into<String>) -> Self {
        Self { kind: ErrorKind::WindowNotFound, message: msg.into() }
    }
    pub fn permission_denied(msg: impl Into<String>) -> Self {
        Self { kind: ErrorKind::PermissionDenied, message: msg.into() }
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self { kind: ErrorKind::NotFound, message: msg.into() }
    }
    pub fn platform(msg: impl Into<String>) -> Self {
        Self { kind: ErrorKind::Platform, message: msg.into() }
    }
}

impl std::fmt::Display for NativeTerminalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

// spawn 時のオプション。cwd は WSL 内パス(Win/Mac とも同じ表現で渡す)。
#[derive(Debug, Clone)]
pub struct SpawnOptions {
    pub pane_id: String,
    pub cwd: Option<String>,
    pub rect: PaneRect,
    pub session_type: SessionType,
}

#[derive(Debug, Clone, Copy)]
pub enum SessionType {
    Claude,
    Shell,
}

/// プラットフォーム共通のネイティブ端末オーバーレイ backend。
///
/// 注意: 実装は全て **非ブロッキング**でなければならない。`spawn` も内部でスレッドを
/// 起動して即 return する。Frontend 側は spawn 完了イベントを listen する。
pub trait NativeTerminalBackend: Send + Sync {
    /// 新規ペインのターミナルを起動し、矩形に配置開始する。
    /// 起動完了時に Tauri Window 経由で "native-terminal-ready" emit する責務は manager 側。
    fn spawn(&self, opts: SpawnOptions) -> Result<(), NativeTerminalError>;

    /// 既存ペインの矩形を更新(ResizeObserver / WindowEvent::Moved/Resized から呼ばれる)。
    fn update_rect(&self, pane_id: &str, rect: PaneRect) -> Result<(), NativeTerminalError>;

    /// 可視状態の切替(タブ切替・detach・最小化・フルスクリーン等)。
    fn set_visible(&self, pane_id: &str, visible: bool) -> Result<(), NativeTerminalError>;

    /// ペインを閉じる(プロセス終了 + ハンドル破棄)。
    fn close(&self, pane_id: &str) -> Result<(), NativeTerminalError>;

    /// 全ペインを閉じる(アプリ終了時)。エラーは無視。
    fn close_all(&self);

    /// バックエンドがこの OS で動作可能か(権限チェックを含む)。
    /// 「OS は対応しているが Accessibility 未許可」のような状態はここで false を返す。
    fn is_available(&self) -> bool;

    /// 「使えるけど Mac の Accessibility が未許可」のような状態用。
    /// 未許可なら詳細メッセージを返す、許可済みなら None。
    fn permission_status(&self) -> Option<String> {
        None
    }

    /// 全ペインの矩形を再適用する(Tauri メインウィンドウが移動・リサイズした時用)。
    /// React 側 getBoundingClientRect は client 相対なのでメイン窓の移動だけでは変わらず、
    /// Rust 側で保存している last_rect を「新しい inner_position オフセット」で再計算して
    /// SetWindowPos (Win) / AXSetAttributeValue (Mac) で wt.exe / Terminal.app を追従させる。
    /// macOS は AXAPI 内で既にグローバル座標を使うため通常 no-op で可。
    fn reapply_all_rects(&self) {}
}

/// 非対応 OS 用のスタブ。全 API が NotSupported を返す。
pub struct NotSupportedBackend;

impl NativeTerminalBackend for NotSupportedBackend {
    fn spawn(&self, _: SpawnOptions) -> Result<(), NativeTerminalError> {
        Err(NativeTerminalError::not_supported())
    }
    fn update_rect(&self, _: &str, _: PaneRect) -> Result<(), NativeTerminalError> {
        Err(NativeTerminalError::not_supported())
    }
    fn set_visible(&self, _: &str, _: bool) -> Result<(), NativeTerminalError> {
        Err(NativeTerminalError::not_supported())
    }
    fn close(&self, _: &str) -> Result<(), NativeTerminalError> {
        Err(NativeTerminalError::not_supported())
    }
    fn close_all(&self) {}
    fn is_available(&self) -> bool { false }
}
