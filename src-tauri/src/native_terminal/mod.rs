// ネイティブ端末オーバーレイモジュール(Preview 機能)。
//
// Tauri デスクトップ版でのみ有効。ペイン矩形に OS 純正端末(Win=wt.exe / Mac=Terminal.app)を
// 常時最前面で重ねる試作実装。ブラウザ版(localhost:9100)には影響しない。
//
// 構成:
//   - traits   : プラットフォーム共通の trait と型
//   - manager  : Tauri command 配線 + ハンドルレジストリ
//   - watcher  : プロセス終了監視
//   - windows  : Win32 / windows-rs 実装(target_os = "windows")
//   - macos    : AXAPI / NSWindowLevel 実装(target_os = "macos")
//
// Linux/その他では backend は NotSupported を返し、Frontend 側で xterm にフォールバックする。

pub mod traits;
pub mod manager;
pub mod watcher;

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "macos")]
pub mod macos;

use std::sync::Arc;
use traits::NativeTerminalBackend;

/// プラットフォームに応じた backend を 1 つだけ生成する。
/// 対応外 OS では NotSupportedBackend を返す(全 API がエラーを返すスタブ)。
pub fn create_backend() -> Arc<dyn NativeTerminalBackend> {
    #[cfg(target_os = "windows")]
    {
        return Arc::new(windows::WindowsBackend::new());
    }
    #[cfg(target_os = "macos")]
    {
        return Arc::new(macos::MacOsBackend::new());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Arc::new(traits::NotSupportedBackend)
    }
}
