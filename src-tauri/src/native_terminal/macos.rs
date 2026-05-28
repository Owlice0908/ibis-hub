// macOS 用 NativeTerminalBackend 実装(AXAPI ベースのフローティングオーバーレイ方式)。
//
// 設計方針:
//   - macOS は他アプリ NSWindow を自アプリの子ウィンドウに親子付け不可。
//   - そこで Yabai / Rectangle / Magnet と同じく、AXAPI で対象ウィンドウ(Terminal.app)を
//     reposition/resize する。タブ切替時は kAXMinimizedAttribute で最小化、復帰時は
//     最小化を解除して kAXRaiseAction で前面化する。
//
//   - すべての AX/Cocoa 呼び出しは **main thread** で行う(undefined behavior 回避)。
//     spawn 関数本体は事前検査(権限・Terminal.app 存在)だけ済ませて、osascript 起動以降は
//     別スレッドへ送って即 return する(trait の「非ブロッキング」要件)。
//
//   - AXUIElement は CFRetain で保持し、TermHandle.ax_window に usize として格納する。
//     close 時に CFRelease する。
//
// TODO:
//   - kAXUIElementDestroyedNotification の AXObserver 監視は将来追加。現状は 5 秒間隔で
//     AXUIElementCopyAttributeValue(kAXTitleAttribute) を呼び、kAXErrorInvalidUIElement
//     が返ったら exited と判定する。
//   - CGWindowList を使った window-id ベースの厳密マッチングは未実装(タイトル一意性で代替)。

#![cfg(target_os = "macos")]
#![allow(non_upper_case_globals)]

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager};

use accessibility_sys::{
    kAXErrorSuccess, kAXMinimizedAttribute, kAXPositionAttribute, kAXPressAction,
    kAXRaiseAction, kAXSizeAttribute, kAXTitleAttribute, kAXTrustedCheckOptionPrompt,
    kAXValueTypeCGPoint, kAXValueTypeCGSize, kAXWindowsAttribute, AXError, AXIsProcessTrusted,
    AXIsProcessTrustedWithOptions, AXUIElementCopyAttributeValue, AXUIElementCreateApplication,
    AXUIElementPerformAction, AXUIElementRef, AXUIElementSetAttributeValue, AXValueCreate,
};

use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use core_foundation_sys::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
use core_foundation_sys::base::{CFRelease, CFRetain, CFTypeRef};
use core_foundation_sys::string::CFStringRef;

use core_graphics::geometry::{CGPoint, CGSize};

use objc::runtime::Object;
use objc::{class, msg_send, sel, sel_impl};

use super::traits::{NativeTerminalBackend, NativeTerminalError, PaneRect, SpawnOptions};

// ───────────────────────────────────────────────────────────────────────
// AppHandle 保持(lib.rs の setup で set_app_handle() を呼ぶ前提)
// ───────────────────────────────────────────────────────────────────────

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// lib.rs の setup から呼ぶ。AppHandle をモジュールスコープに保管する。
pub fn set_app_handle(app: AppHandle) {
    let _ = APP_HANDLE.set(app);
}

fn log(msg: &str) {
    // crate::log() を呼ぶ。lib.rs の log() は pub(crate) ではないが、crate ルートで
    // `fn log` として定義されているので super 経由でアクセスできる。
    crate::log(msg);
}

fn emit_error(pane_id: &str, message: &str) {
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit(
            "native-terminal-error",
            serde_json::json!({ "paneId": pane_id, "error": message }),
        );
    }
    log(&format!("[native_terminal/macos] error pane={} msg={}", pane_id, message));
}

fn emit_ready(pane_id: &str) {
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit(
            "native-terminal-ready",
            serde_json::json!({ "paneId": pane_id }),
        );
    }
}

fn emit_exited(pane_id: &str) {
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit(
            "native-terminal-exited",
            serde_json::json!({ "paneId": pane_id }),
        );
    }
}

// ───────────────────────────────────────────────────────────────────────
// 内部状態
// ───────────────────────────────────────────────────────────────────────

#[allow(dead_code)]
struct TermHandle {
    pid: i32,
    /// AXUIElementRef を CFRetain 済みの状態で usize にキャスト保管。
    /// 取り出す時は `_ax_window as AXUIElementRef`。close 時に CFRelease する。
    ax_window: usize,
    last_rect: PaneRect,
    visible: bool,
    /// 監視スレッドへ「もう close した」を伝えるフラグ。
    closed: Arc<std::sync::atomic::AtomicBool>,
}

pub struct MacOsBackend {
    inner: Arc<Mutex<HashMap<String, TermHandle>>>,
}

impl MacOsBackend {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// MacOsBackend の中身は Arc<Mutex<HashMap<String, TermHandle>>> で、TermHandle は
// usize / Arc<AtomicBool> のみ。pointer は usize に押し込んでいるので Send/Sync が
// auto-derive される。明示的 unsafe impl は不要(競合エラーになる)。

// ───────────────────────────────────────────────────────────────────────
// 権限チェック
// ───────────────────────────────────────────────────────────────────────

fn check_accessibility(prompt: bool) -> bool {
    unsafe {
        if prompt {
            // 辞書 { kAXTrustedCheckOptionPrompt: kCFBooleanTrue } を作って渡す
            let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
            let val = CFBoolean::true_value();
            let dict = CFDictionary::from_CFType_pairs(&[(key, val)]);
            AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef() as _)
        } else {
            AXIsProcessTrusted()
        }
    }
}

// ───────────────────────────────────────────────────────────────────────
// CFString 生成ヘルパ(static &str → CFStringRef)
// ───────────────────────────────────────────────────────────────────────

/// `&str` から CFString を作って raw CFStringRef を返す。返値は **CFString が drop すると release される** ため、
/// 短命使用ならば `let cf = make_cfstring(...); use(cf.as_concrete_TypeRef());` のパターンで安全。
fn make_cfstring(s: &str) -> CFString {
    CFString::new(s)
}

// ───────────────────────────────────────────────────────────────────────
// AXAPI ヘルパ
// ───────────────────────────────────────────────────────────────────────

/// AXUIElementCopyAttributeValue ラッパ。成功時は CFTypeRef(CFRetained 済み相当)を返す。
unsafe fn ax_copy_attr(elem: AXUIElementRef, attr: &str) -> Option<CFTypeRef> {
    let attr_cf = make_cfstring(attr);
    let mut out: CFTypeRef = std::ptr::null();
    let err: AXError =
        AXUIElementCopyAttributeValue(elem, attr_cf.as_concrete_TypeRef(), &mut out as *mut _);
    if err == kAXErrorSuccess && !out.is_null() {
        Some(out)
    } else {
        None
    }
}

/// Terminal.app の全 AX ウィンドウから title が target_title に一致する AXUIElementRef を返す。
/// 戻り値は **CFRetain 済み**(呼び出し側が後で CFRelease する責務)。
unsafe fn find_window_by_title(pid: i32, target_title: &str) -> Option<AXUIElementRef> {
    let app_elem: AXUIElementRef = AXUIElementCreateApplication(pid);
    if app_elem.is_null() {
        return None;
    }
    // app_elem も CFRetained。最後に release する。
    let _app_guard = AxRefGuard(app_elem as CFTypeRef);

    // kAXWindowsAttribute は CFArray<AXUIElementRef>
    let windows_ref = match ax_copy_attr(app_elem, kAXWindowsAttribute) {
        Some(r) => r,
        None => return None,
    };
    let windows_array = windows_ref as CFArrayRef;
    let count = CFArrayGetCount(windows_array);

    let mut found: Option<AXUIElementRef> = None;
    for i in 0..count {
        let w_ptr = CFArrayGetValueAtIndex(windows_array, i);
        if w_ptr.is_null() {
            continue;
        }
        let window: AXUIElementRef = w_ptr as AXUIElementRef;

        // タイトル取得
        if let Some(title_ref) = ax_copy_attr(window, kAXTitleAttribute) {
            let title_cf: CFString = CFString::wrap_under_create_rule(title_ref as CFStringRef);
            let title_str = title_cf.to_string();
            if title_str == target_title {
                // CFRetain して所有権を確保する(CFArray release で消えないように)
                let retained = CFRetain(window as CFTypeRef);
                found = Some(retained as AXUIElementRef);
                break;
            }
        }
    }

    CFRelease(windows_ref);
    found
}

/// Drop で CFRelease する RAII ガード。
struct AxRefGuard(CFTypeRef);
impl Drop for AxRefGuard {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() {
                CFRelease(self.0);
            }
        }
    }
}

/// NSRunningApplication 経由で Terminal.app の PID 一覧を取得。
/// 別スレッドから呼ばれる可能性があるため NSAutoreleasePool を内部で取り、
/// Cocoa 由来の autorelease オブジェクトをリークさせない。
fn terminal_app_pids() -> Vec<i32> {
    let mut pids = Vec::new();
    unsafe {
        let pool: *mut Object = msg_send![class!(NSAutoreleasePool), new];
        let cls = class!(NSRunningApplication);
        let bundle_id_ns: *mut Object = {
            let s: *mut Object = msg_send![class!(NSString), alloc];
            let bytes = "com.apple.Terminal".as_ptr();
            let len = "com.apple.Terminal".len();
            let initialized: *mut Object = msg_send![s,
                initWithBytes:bytes as *const c_void
                length:len
                encoding:4_usize /* NSUTF8StringEncoding */];
            initialized
        };
        let apps: *mut Object = msg_send![cls, runningApplicationsWithBundleIdentifier: bundle_id_ns];
        let _: () = msg_send![bundle_id_ns, release];
        if !apps.is_null() {
            let count: usize = msg_send![apps, count];
            for i in 0..count {
                let app: *mut Object = msg_send![apps, objectAtIndex: i];
                if app.is_null() {
                    continue;
                }
                let pid: i32 = msg_send![app, processIdentifier];
                if pid > 0 {
                    pids.push(pid);
                }
            }
        }
        let _: () = msg_send![pool, drain];
    }
    pids
}

// ───────────────────────────────────────────────────────────────────────
// メインウィンドウのグローバル座標とスケール取得
// ───────────────────────────────────────────────────────────────────────

/// Tauri main window の位置(physical px)と scale_factor を取得。失敗時は (0,0,1.0)。
/// AX 座標系は points なので、論理座標(physical / scale)を返す。
fn main_window_origin_points() -> (f64, f64, f64) {
    let Some(app) = APP_HANDLE.get() else {
        return (0.0, 0.0, 1.0);
    };
    let Some(win) = app.get_webview_window("main") else {
        return (0.0, 0.0, 1.0);
    };
    let scale = win.scale_factor().unwrap_or(1.0);
    let pos = win
        .outer_position()
        .ok()
        .map(|p| (p.x as f64, p.y as f64))
        .unwrap_or((0.0, 0.0));
    // outer_position は physical px。AX は points。
    (pos.0 / scale, pos.1 / scale, scale)
}

// ───────────────────────────────────────────────────────────────────────
// AX へ位置/サイズを書き込む
// ───────────────────────────────────────────────────────────────────────

/// rect(論理 CSS px、Tauri main window 内ローカル)を AX グローバル座標(points)に変換して
/// AXPosition / AXSize を SetAttributeValue する。**main thread からのみ呼ぶこと**。
unsafe fn apply_rect_to_ax(ax_window: AXUIElementRef, rect: PaneRect) -> Result<(), AXError> {
    // ペインの位置は frontend の CSS px(論理単位)。
    // メインウィンドウの outer_position はグローバル physical px。
    // scale_factor で割って論理(points)化したものを足し、AX 座標(points)に揃える。
    let (main_x_pts, main_y_pts, _scale) = main_window_origin_points();
    let global_x = main_x_pts + rect.x;
    let global_y = main_y_pts + rect.y;
    let width = rect.width.max(1.0);
    let height = rect.height.max(1.0);

    // CGPoint
    let pt = CGPoint::new(global_x, global_y);
    let pt_val = AXValueCreate(kAXValueTypeCGPoint, &pt as *const _ as *const c_void);
    if pt_val.is_null() {
        return Err(-1);
    }
    let pos_attr = make_cfstring(kAXPositionAttribute);
    let err1 =
        AXUIElementSetAttributeValue(ax_window, pos_attr.as_concrete_TypeRef(), pt_val as CFTypeRef);
    CFRelease(pt_val as CFTypeRef);
    if err1 != kAXErrorSuccess {
        return Err(err1);
    }

    // CGSize
    let sz = CGSize::new(width, height);
    let sz_val = AXValueCreate(kAXValueTypeCGSize, &sz as *const _ as *const c_void);
    if sz_val.is_null() {
        return Err(-1);
    }
    let size_attr = make_cfstring(kAXSizeAttribute);
    let err2 = AXUIElementSetAttributeValue(
        ax_window,
        size_attr.as_concrete_TypeRef(),
        sz_val as CFTypeRef,
    );
    CFRelease(sz_val as CFTypeRef);
    if err2 != kAXErrorSuccess {
        return Err(err2);
    }
    Ok(())
}

/// main thread にディスパッチして apply_rect_to_ax を呼ぶ。同期(channel で待つ)。
fn dispatch_apply_rect(ax_window: usize, rect: PaneRect) -> Result<(), NativeTerminalError> {
    let Some(app) = APP_HANDLE.get() else {
        return Err(NativeTerminalError::platform("AppHandle not initialized"));
    };
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), AXError>>();
    let r = app.run_on_main_thread(move || {
        let result = unsafe { apply_rect_to_ax(ax_window as AXUIElementRef, rect) };
        let _ = tx.send(result);
    });
    if let Err(e) = r {
        return Err(NativeTerminalError::platform(format!(
            "run_on_main_thread failed: {}",
            e
        )));
    }
    match rx.recv() {
        Ok(Ok(())) => Ok(()),
        Ok(Err(code)) => Err(NativeTerminalError::platform(format!(
            "AXSetAttributeValue failed: code={}",
            code
        ))),
        Err(e) => Err(NativeTerminalError::platform(format!(
            "channel recv failed: {}",
            e
        ))),
    }
}

// ───────────────────────────────────────────────────────────────────────
// spawn(): osascript 起動 + AX ウィンドウ発見 + 初期配置
// ───────────────────────────────────────────────────────────────────────

/// AppleScript の文字列に渡す前にダブルクォートとバックスラッシュをエスケープ。
fn applescript_quote(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn launch_terminal_osascript(pane_id: &str, cwd: Option<&str>) -> Result<(), String> {
    let cwd_val = cwd.unwrap_or("~");
    let unique_title = format!("ibis-native-{}", pane_id);
    // bash/zsh 引数も AppleScript リテラル内に入るので二重エスケープが必要。
    // do script の引数自体が AppleScript の string なのでバックスラッシュとダブルクォート対応で十分。
    let inner_cmd = format!("cd {} && exec zsh -lic 'claude -c'", cwd_val);
    // Terminal.app では window の表示タイトルは `custom title` プロパティで上書きできる。
    // `name of window 1` は read-only に近い(custom title が無ければ自動生成タイトルが返る)。
    let script = format!(
        r#"tell application "Terminal"
    activate
    do script "{}"
    delay 0.1
    set custom title of front window to "{}"
end tell"#,
        applescript_quote(&inner_cmd),
        applescript_quote(&unique_title),
    );

    let mut cmd = std::process::Command::new("osascript");
    cmd.arg("-e").arg(&script);
    match cmd.spawn() {
        Ok(mut child) => {
            // osascript は短時間で終わる。wait してエラー出力を拾う。
            let _ = child.wait();
            Ok(())
        }
        Err(e) => Err(format!("osascript spawn failed: {}", e)),
    }
}

/// タイトル一致する AX window を 50ms × 60 回ポーリングで探す。
/// 戻り値: (pid, ax_window_ref CFRetain 済み)。
unsafe fn poll_for_window(unique_title: &str) -> Option<(i32, AXUIElementRef)> {
    for _ in 0..60 {
        let pids = terminal_app_pids();
        for pid in pids {
            if let Some(win) = find_window_by_title(pid, unique_title) {
                return Some((pid, win));
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
    None
}

// ───────────────────────────────────────────────────────────────────────
// ウィンドウ生存監視(5 秒ごとに kAXTitleAttribute を読み、失敗したら exited)
// ───────────────────────────────────────────────────────────────────────

fn start_alive_watcher(
    pane_id: String,
    ax_window: usize,
    inner: Arc<Mutex<HashMap<String, TermHandle>>>,
    closed_flag: Arc<std::sync::atomic::AtomicBool>,
) {
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_secs(5));
            if closed_flag.load(std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            // タイトル取得失敗 → ウィンドウ消滅と判定
            let alive = unsafe {
                let attr = make_cfstring(kAXTitleAttribute);
                let mut out: CFTypeRef = std::ptr::null();
                let err = AXUIElementCopyAttributeValue(
                    ax_window as AXUIElementRef,
                    attr.as_concrete_TypeRef(),
                    &mut out as *mut _,
                );
                if !out.is_null() {
                    CFRelease(out);
                }
                err == kAXErrorSuccess
            };
            if !alive {
                // map から取り出して CFRelease
                let removed = {
                    let mut guard = inner.lock();
                    guard.remove(&pane_id)
                };
                if let Some(h) = removed {
                    unsafe { CFRelease(h.ax_window as CFTypeRef) };
                }
                emit_exited(&pane_id);
                return;
            }
        }
    });
}

// ───────────────────────────────────────────────────────────────────────
// trait 実装
// ───────────────────────────────────────────────────────────────────────

impl NativeTerminalBackend for MacOsBackend {
    fn spawn(&self, opts: SpawnOptions) -> Result<(), NativeTerminalError> {
        // 1) Accessibility 権限チェック
        if !check_accessibility(false) {
            // プロンプトを出してから permission_denied を返す
            let _ = check_accessibility(true);
            return Err(NativeTerminalError::permission_denied(
                "アクセシビリティ権限が必要です。システム設定 → プライバシーとセキュリティ → アクセシビリティ で ibis-hub を許可してください。",
            ));
        }

        // 2) Terminal.app の存在チェック
        if !self.is_available() {
            return Err(NativeTerminalError::not_supported());
        }

        // 3) 残りの作業は別スレッドへ。spawn() 自体は即 return(trait 要件)。
        let pane_id = opts.pane_id.clone();
        let cwd = opts.cwd.clone();
        let rect = opts.rect;
        let inner = Arc::clone(&self.inner);

        // すでに同 pane_id が存在 → AlreadyExists
        {
            let guard = self.inner.lock();
            if guard.contains_key(&pane_id) {
                return Err(NativeTerminalError {
                    kind: super::traits::ErrorKind::AlreadyExists,
                    message: format!("pane_id {} は既に存在", pane_id),
                });
            }
        }

        thread::spawn(move || {
            log(&format!("[native_terminal/macos] spawning pane={}", pane_id));

            // osascript 起動
            if let Err(e) = launch_terminal_osascript(&pane_id, cwd.as_deref()) {
                emit_error(&pane_id, &format!("Terminal.app 起動失敗: {}", e));
                return;
            }

            // Terminal が前面化されるまで少し待つ
            thread::sleep(Duration::from_millis(250));

            // AX で対象ウィンドウを発見
            let unique_title = format!("ibis-native-{}", pane_id);
            let found = unsafe { poll_for_window(&unique_title) };
            let (pid, ax_window) = match found {
                Some(v) => v,
                None => {
                    emit_error(
                        &pane_id,
                        "Terminal ウィンドウが見つかりませんでした(タイトル不一致 or 起動失敗)",
                    );
                    return;
                }
            };
            let ax_window_usize = ax_window as usize;

            // ハンドル登録
            let closed_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
            {
                let mut guard = inner.lock();
                guard.insert(
                    pane_id.clone(),
                    TermHandle {
                        pid,
                        ax_window: ax_window_usize,
                        last_rect: rect,
                        visible: true,
                        closed: Arc::clone(&closed_flag),
                    },
                );
            }

            // 初期配置(main thread にディスパッチ)
            if let Err(e) = dispatch_apply_rect(ax_window_usize, rect) {
                log(&format!(
                    "[native_terminal/macos] initial apply_rect failed pane={} err={}",
                    pane_id, e.message
                ));
                // 失敗しても続行(後続の update_rect で復帰の可能性)
            }

            // 生存監視を開始
            start_alive_watcher(
                pane_id.clone(),
                ax_window_usize,
                Arc::clone(&inner),
                closed_flag,
            );

            emit_ready(&pane_id);
        });

        Ok(())
    }

    fn update_rect(&self, pane_id: &str, rect: PaneRect) -> Result<(), NativeTerminalError> {
        // 1px 未満なら no-op
        let ax_window = {
            let mut guard = self.inner.lock();
            let Some(h) = guard.get_mut(pane_id) else {
                return Err(NativeTerminalError::not_found(format!(
                    "pane_id {} 未登録",
                    pane_id
                )));
            };
            let same = (h.last_rect.x - rect.x).abs() < 1.0
                && (h.last_rect.y - rect.y).abs() < 1.0
                && (h.last_rect.width - rect.width).abs() < 1.0
                && (h.last_rect.height - rect.height).abs() < 1.0;
            if same {
                return Ok(());
            }
            h.last_rect = rect;
            h.ax_window
        };
        dispatch_apply_rect(ax_window, rect)
    }

    fn set_visible(&self, pane_id: &str, visible: bool) -> Result<(), NativeTerminalError> {
        let ax_window = {
            let mut guard = self.inner.lock();
            let Some(h) = guard.get_mut(pane_id) else {
                return Err(NativeTerminalError::not_found(format!(
                    "pane_id {} 未登録",
                    pane_id
                )));
            };
            if h.visible == visible {
                return Ok(());
            }
            h.visible = visible;
            h.ax_window
        };

        let Some(app) = APP_HANDLE.get() else {
            return Err(NativeTerminalError::platform("AppHandle not initialized"));
        };
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), AXError>>();
        let r = app.run_on_main_thread(move || {
            let result: Result<(), AXError> = unsafe {
                let attr = make_cfstring(kAXMinimizedAttribute);
                let bool_ref = if visible {
                    CFBoolean::false_value()
                } else {
                    CFBoolean::true_value()
                };
                let err = AXUIElementSetAttributeValue(
                    ax_window as AXUIElementRef,
                    attr.as_concrete_TypeRef(),
                    bool_ref.as_concrete_TypeRef() as CFTypeRef,
                );
                if err != kAXErrorSuccess {
                    Err(err)
                } else {
                    if visible {
                        // 前面化
                        let raise = make_cfstring(kAXRaiseAction);
                        let _ = AXUIElementPerformAction(
                            ax_window as AXUIElementRef,
                            raise.as_concrete_TypeRef(),
                        );
                    }
                    Ok(())
                }
            };
            let _ = tx.send(result);
        });
        if let Err(e) = r {
            return Err(NativeTerminalError::platform(format!(
                "run_on_main_thread failed: {}",
                e
            )));
        }
        match rx.recv() {
            Ok(Ok(())) => Ok(()),
            Ok(Err(code)) => Err(NativeTerminalError::platform(format!(
                "AXSetAttributeValue(minimized) failed: code={}",
                code
            ))),
            Err(e) => Err(NativeTerminalError::platform(format!(
                "channel recv failed: {}",
                e
            ))),
        }
    }

    fn close(&self, pane_id: &str) -> Result<(), NativeTerminalError> {
        let removed = {
            let mut guard = self.inner.lock();
            guard.remove(pane_id)
        };
        let Some(h) = removed else {
            return Err(NativeTerminalError::not_found(format!(
                "pane_id {} 未登録",
                pane_id
            )));
        };

        // alive watcher を停止
        h.closed.store(true, std::sync::atomic::Ordering::SeqCst);

        let ax_window = h.ax_window;
        let pane_id_str = pane_id.to_string();

        // main thread でクローズ試行 → CFRelease
        let Some(app) = APP_HANDLE.get() else {
            // AppHandle 無くても CFRelease だけは試みる(プロセス終了直前等)
            unsafe { CFRelease(ax_window as CFTypeRef) };
            return Ok(());
        };
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let _ = app.run_on_main_thread(move || {
            unsafe {
                // 1) AXCloseButton 属性を取って AXPress
                let close_btn_attr = make_cfstring("AXCloseButton");
                let mut btn_ref: CFTypeRef = std::ptr::null();
                let err = AXUIElementCopyAttributeValue(
                    ax_window as AXUIElementRef,
                    close_btn_attr.as_concrete_TypeRef(),
                    &mut btn_ref as *mut _,
                );
                let mut pressed = false;
                if err == kAXErrorSuccess && !btn_ref.is_null() {
                    let press_action = make_cfstring(kAXPressAction);
                    let perr = AXUIElementPerformAction(
                        btn_ref as AXUIElementRef,
                        press_action.as_concrete_TypeRef(),
                    );
                    if perr == kAXErrorSuccess {
                        pressed = true;
                    }
                    CFRelease(btn_ref);
                }

                // 2) フォールバック: AppleScript で window を close
                if !pressed {
                    let script = format!(
                        r#"tell application "Terminal"
    try
        close (every window whose name is "ibis-native-{}")
    end try
end tell"#,
                        applescript_quote(&pane_id_str)
                    );
                    let _ = std::process::Command::new("osascript")
                        .arg("-e")
                        .arg(&script)
                        .spawn()
                        .and_then(|mut c| c.wait());
                }

                CFRelease(ax_window as CFTypeRef);
            }
            let _ = tx.send(());
        });
        let _ = rx.recv();
        Ok(())
    }

    fn close_all(&self) {
        // 全 pane_id を集めて close を呼ぶ(エラーは無視)
        let ids: Vec<String> = {
            let guard = self.inner.lock();
            guard.keys().cloned().collect()
        };
        for id in ids {
            let _ = self.close(&id);
        }
    }

    fn is_available(&self) -> bool {
        std::path::Path::new("/System/Applications/Utilities/Terminal.app").exists()
            || std::path::Path::new("/Applications/Utilities/Terminal.app").exists()
    }

    fn permission_status(&self) -> Option<String> {
        if check_accessibility(false) {
            None
        } else {
            Some("アクセシビリティ権限を許可してください(システム設定 → プライバシーとセキュリティ → アクセシビリティ で ibis-hub を有効化)".to_string())
        }
    }
}
