// Win32 / windows-rs 実装 (Preview)。
//
// 役割:
//   - wt.exe (Windows Terminal) を別プロセスで起動し、生成された CASCADIA_HOSTING_WINDOW_CLASS
//     の HWND を EnumWindows で発見する
//   - 取得した HWND を「枠なし・非アクティブ化・常時最前面候補」に整形し、Frontend から渡された
//     CSS px の矩形(scaleFactor 込み)へ SetWindowPos で配置する
//   - 矩形変化(update_rect)・可視切替(set_visible)・終了(close / close_all)に追随
//   - wt.exe が ibis-hub 経由ではなく直接閉じられた場合は WaitForSingleObject で検知して
//     native-terminal-exited を emit する
//
// 重要な設計判断:
//   - spawn() は trait 上「非ブロッキング」を要求されている。本実装では wt.exe を立ち上げた直後に
//     HWND 探索ループを別スレッドへ送り、spawn 関数本体は Ok(()) で即 return する
//   - Tauri AppHandle は trait シグネチャに含められないので、本モジュール内に OnceLock で保持し、
//     lib.rs の setup から set_app_handle() で注入する
//   - HWND は !Send なので isize (HWND as isize) として保管する
//   - update_rect の失敗(SetWindowPos エラー)はサイレント。フレームごとに来るのでログ汚染を避ける

#![cfg(target_os = "windows")]

use std::collections::HashMap;
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use windows::Win32::Foundation::{BOOL, HWND, LPARAM, WPARAM};
use windows::Win32::System::Threading::{
    OpenProcess, WaitForSingleObject, INFINITE, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};
use windows::Win32::System::Threading::TerminateProcess;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowLongPtrW, GetWindowTextW, IsWindowVisible,
    PostMessageW, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, GWL_STYLE, HWND_TOP,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW,
    SW_HIDE, SW_SHOWNOACTIVATE, WM_CLOSE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_OVERLAPPEDWINDOW,
};

use super::traits::{NativeTerminalBackend, NativeTerminalError, PaneRect, SpawnOptions};
use super::watcher::watch_child_exit;

// wt.exe 由来のホスト HWND が持つクラス名(Windows Terminal の島ウィンドウ)。
const CASCADIA_HOSTING_WINDOW_CLASS: &str = "CASCADIA_HOSTING_WINDOW_CLASS";

// HWND 探索の上限(50ms × 60 = 3 秒)。
// wt.exe は AppX 初回起動 + WSL distribution 起動で 2〜5 秒掛かることがある。
// preview.6 までは 3 秒(50ms × 60)だったが、HWND を取り損ねていた。
// agent 2 (2026-05-28) 結論に従い 10 秒(100ms × 100)に延長。
const HWND_POLL_INTERVAL: Duration = Duration::from_millis(100);
const HWND_POLL_MAX_ATTEMPTS: u32 = 100;

// Tauri AppHandle 注入用。setup() からセットされる前に spawn が呼ばれた場合は emit を諦める。
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// lib.rs の setup から 1 度だけ呼ぶ。AppHandle を本モジュールに渡し、以後 emit に使う。
pub fn set_app_handle(app: AppHandle) {
    // 二度目以降の set は黙って無視(誤って複数回呼んでもクラッシュさせない)。
    let _ = APP_HANDLE.set(app);
}

fn app_handle() -> Option<&'static AppHandle> {
    APP_HANDLE.get()
}

fn emit_event(event: &str, pane_id: &str, extra: Option<&str>) {
    if let Some(app) = app_handle() {
        let payload = match extra {
            Some(msg) => serde_json::json!({ "paneId": pane_id, "message": msg }),
            None => serde_json::json!({ "paneId": pane_id }),
        };
        if let Err(e) = app.emit(event, payload) {
            crate::log(&format!(
                "native_terminal/windows: emit '{}' failed for pane={}: {}",
                event, pane_id, e
            ));
        }
    } else {
        crate::log(&format!(
            "native_terminal/windows: APP_HANDLE not initialized; cannot emit '{}' for pane={}",
            event, pane_id
        ));
    }
}

#[derive(Clone, Copy)]
struct TermHandle {
    pid: u32,
    /// CASCADIA_HOSTING_WINDOW_CLASS の HWND。HWND は !Send/!Sync なので isize で保管する。
    hwnd: isize,
    last_rect: PaneRect,
    visible: bool,
}

pub struct WindowsBackend {
    inner: Arc<Mutex<HashMap<String, TermHandle>>>,
}

impl WindowsBackend {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for WindowsBackend {
    fn default() -> Self {
        Self::new()
    }
}

// ─── EnumWindows 用のパラメータ受け渡し ──────────────────────────────────────
//
// HWND 探索の方針(2026-05-28 agent 2 結論):
// - 当初は PID 一致で探していたが、wt.exe は 0 バイト stub で即終了し、
//   本体は別 PID の WindowsTerminal.exe として再起動される。よって PID 一致では
//   永遠に HWND を取得できない仕様だった。
// - 代わりに **ウィンドウタイトル一致**で探索する。spawn 時に `--title ibis-native-<uuid>`
//   を付けているので、CASCADIA_HOSTING_WINDOW_CLASS + タイトル一致で一意に特定可能。

struct EnumCtx {
    target_title: Vec<u16>, // UTF-16 表現で比較するため事前変換
    found_hwnd: isize,      // 0 == not found yet
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut EnumCtx);

    // 可視ウィンドウのみ対象(wt.exe は内部に不可視ウィンドウも作る)。
    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);
    }

    // クラス名が CASCADIA_HOSTING_WINDOW_CLASS か?
    let mut class_buf = [0u16; 256];
    let class_len = GetClassNameW(hwnd, &mut class_buf);
    if class_len <= 0 {
        return BOOL(1);
    }
    let class_name = String::from_utf16_lossy(&class_buf[..class_len as usize]);
    if class_name != CASCADIA_HOSTING_WINDOW_CLASS {
        return BOOL(1);
    }

    // タイトル一致チェック(target_title が含まれるか部分一致で判定)
    let mut title_buf = [0u16; 512];
    let title_len = GetWindowTextW(hwnd, &mut title_buf);
    if title_len <= 0 {
        return BOOL(1);
    }
    let title = String::from_utf16_lossy(&title_buf[..title_len as usize]);
    let target = String::from_utf16_lossy(&ctx.target_title);
    if title.contains(&target) {
        ctx.found_hwnd = hwnd.0 as isize;
        return BOOL(0); // 終了
    }
    BOOL(1)
}

/// 指定タイトル文字列を含む CASCADIA_HOSTING_WINDOW_CLASS の HWND を 1 つ返す。
/// 見つからなければ 0 を返す。
fn find_hwnd_by_title(title: &str) -> isize {
    let target_title: Vec<u16> = title.encode_utf16().collect();
    let mut ctx = EnumCtx { target_title, found_hwnd: 0 };
    let lparam = LPARAM(&mut ctx as *mut _ as isize);
    let _ = unsafe { EnumWindows(Some(enum_proc), lparam) };
    ctx.found_hwnd
}

// ─── Win32 ヘルパ ───────────────────────────────────────────────────────────

/// 枠・タイトルバーを外し、非アクティブ化・ツールウィンドウ属性を付与する。
fn strip_window_chrome(hwnd: HWND) {
    unsafe {
        // 通常スタイル: WS_OVERLAPPEDWINDOW を除去
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        let new_style = style & !(WS_OVERLAPPEDWINDOW.0 as isize);
        SetWindowLongPtrW(hwnd, GWL_STYLE, new_style);

        // 拡張スタイル: NOACTIVATE + TOOLWINDOW を付与
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let new_ex = ex | (WS_EX_NOACTIVATE.0 as isize) | (WS_EX_TOOLWINDOW.0 as isize);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex);

        // スタイル反映のため framechanged 付きで再描画リクエスト(位置・サイズは保つ)
        let _ = SetWindowPos(
            hwnd,
            HWND::default(),
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

/// Tauri メインウィンドウのクライアント領域(WebView)左上のスクリーン物理 px 座標。
/// 取得失敗時は (0, 0) を返す(= フォールバックでデスクトップ左上扱い)。
fn main_inner_position_screen_px() -> (i32, i32) {
    use tauri::Manager;
    let Some(app) = app_handle() else { return (0, 0); };
    let Some(win) = app.get_webview_window("main") else { return (0, 0); };
    match win.inner_position() {
        Ok(pos) => (pos.x, pos.y),
        Err(_) => (0, 0),
    }
}

/// CSS px の PaneRect(クライアント領域相対座標)を物理 px のスクリーン絶対座標に変換し
/// SetWindowPos で配置する。show=true なら SHOWWINDOW フラグも立てる。
///
/// preview.5〜11 では Tauri ウィンドウのスクリーン位置を加算しておらず、wt.exe が
/// デスクトップ左上に張り付いていた(「枠に収まらない」の真因)。preview.12 で修正。
fn apply_rect(hwnd: HWND, rect: &PaneRect, show: bool) -> windows::core::Result<()> {
    let sf = if rect.scale_factor <= 0.0 { 1.0 } else { rect.scale_factor };
    let (off_x, off_y) = main_inner_position_screen_px();
    // inner_position は既に物理 px(Tauri 2 仕様) なので scaleFactor を掛けない
    let x = off_x + (rect.x * sf).round() as i32;
    let y = off_y + (rect.y * sf).round() as i32;
    let w = (rect.width * sf).round() as i32;
    let h = (rect.height * sf).round() as i32;

    let mut flags = SWP_NOACTIVATE;
    if show {
        flags |= SWP_SHOWWINDOW;
    }

    unsafe { SetWindowPos(hwnd, HWND_TOP, x, y, w, h, flags) }
}

/// 2 つの PaneRect が(scaleFactor 込みで)実質同一なら true。1px 未満精度で比較。
fn rects_equal(a: &PaneRect, b: &PaneRect) -> bool {
    (a.x - b.x).abs() < 1.0
        && (a.y - b.y).abs() < 1.0
        && (a.width - b.width).abs() < 1.0
        && (a.height - b.height).abs() < 1.0
        && (a.scale_factor - b.scale_factor).abs() < 0.01
}

// ─── NativeTerminalBackend 実装 ─────────────────────────────────────────────

impl NativeTerminalBackend for WindowsBackend {
    fn spawn(&self, opts: SpawnOptions) -> Result<(), NativeTerminalError> {
        let pane_id = opts.pane_id.clone();

        // 同 pane_id が既に居れば AlreadyExists 相当(コール側でクリーンアップ済みのはず)。
        if self.inner.lock().contains_key(&pane_id) {
            crate::log(&format!(
                "native_terminal/windows: spawn ignored, pane_id already exists: {}",
                pane_id
            ));
            return Err(NativeTerminalError::spawn_failed(format!(
                "pane_id already exists: {}",
                pane_id
            )));
        }

        // wsl.exe コマンド構築:
        // - cwd None なら Linux 側 HOME(~)に入る
        // - cwd 指定があれば --cd で Linux パスとして明示
        // - bash -l -c で login shell + コマンド実行(-i は -c と非互換なので外す)
        // - WSLENV は wt.exe 経由なので親プロセス側で設定できない代わりに、
        //   wsl.exe の引数で `--exec` を使うパターンも検討したが互換性に難があるため -l に依存
        let inner_cmd = match &opts.cwd {
            Some(c) if !c.is_empty() => {
                let escaped = c.replace('\'', "'\\''");
                format!("cd '{}' && exec claude -c", escaped)
            }
            _ => "exec claude -c".to_string(),
        };

        // wt.exe を起動。タイトルに pane_id を埋め込んで EnumWindows 探索のヒントにする。
        // -w new   : 新ウィンドウ(既存 wt にタブ追加されると HWND を共有されて埋め込み破綻)
        // --title  : 識別用タイトル(これでタイトル一致 HWND 探索が可能)
        // wsl.exe --cd ~ -- bash -l -c "..."
        let title = format!("ibis-native-{}", pane_id);

        crate::log(&format!(
            "native_terminal/windows: spawn pane={} cwd={:?} title={}",
            pane_id, opts.cwd, title
        ));

        let child = match Command::new("wt.exe")
            .arg("-w")
            .arg("new")
            .arg("--title")
            .arg(&title)
            .arg("wsl.exe")
            .arg("-d")
            .arg("Ubuntu")
            .arg("--cd")
            .arg("~")
            .arg("--")
            .arg("bash")
            .arg("-l")
            .arg("-c")
            .arg(&inner_cmd)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                crate::log(&format!(
                    "native_terminal/windows: spawn failed for pane={}: {}",
                    pane_id, e
                ));
                emit_event(
                    "native-terminal-error",
                    &pane_id,
                    Some(&format!("spawn failed: {}", e)),
                );
                return Err(NativeTerminalError::spawn_failed(e.to_string()));
            }
        };

        let pid = child.id();
        crate::log(&format!(
            "native_terminal/windows: wt.exe spawned pane={} pid={}",
            pane_id, pid
        ));

        // ── ここから先は別スレッドへ。spawn 関数本体は即 return する(非ブロッキング要件) ──
        let inner = self.inner.clone();
        let pane_id_for_thread = pane_id.clone();
        let rect = opts.rect;

        let title_for_thread = title.clone();
        thread::spawn(move || {
            // 1) HWND を 100ms 間隔でポーリング(最大 10 秒)。
            //    タイトル一致で探す(PID 一致は wt.exe stub の即終了で動かない)。
            let mut hwnd_isize: isize = 0;
            for _ in 0..HWND_POLL_MAX_ATTEMPTS {
                hwnd_isize = find_hwnd_by_title(&title_for_thread);
                if hwnd_isize != 0 {
                    break;
                }
                thread::sleep(HWND_POLL_INTERVAL);
            }

            if hwnd_isize == 0 {
                crate::log(&format!(
                    "native_terminal/windows: HWND timeout for pane={} title={}",
                    pane_id_for_thread, title_for_thread
                ));
                emit_event(
                    "native-terminal-error",
                    &pane_id_for_thread,
                    Some("HWND timeout: title-match for CASCADIA_HOSTING_WINDOW_CLASS not found within 10s"),
                );
                spawn_exit_watcher(pid, pane_id_for_thread.clone(), inner.clone());
                return;
            }

            let hwnd = HWND(hwnd_isize as *mut _);

            // 2) ウィンドウクロムを剥がす(WS_OVERLAPPEDWINDOW 除去, NOACTIVATE+TOOLWINDOW 付与)
            strip_window_chrome(hwnd);

            // 3) 矩形配置 + 可視化
            if let Err(e) = apply_rect(hwnd, &rect, true) {
                crate::log(&format!(
                    "native_terminal/windows: initial SetWindowPos failed pane={}: {:?}",
                    pane_id_for_thread, e
                ));
            }

            // 4) レジストリに登録
            inner.lock().insert(
                pane_id_for_thread.clone(),
                TermHandle {
                    pid,
                    hwnd: hwnd_isize,
                    last_rect: rect,
                    visible: true,
                },
            );

            // 5) Frontend に「使える」と通知
            emit_event("native-terminal-ready", &pane_id_for_thread, None);
            crate::log(&format!(
                "native_terminal/windows: pane={} ready hwnd={:#x}",
                pane_id_for_thread, hwnd_isize
            ));

            // 6) wt.exe の終了監視(別スレッド)
            spawn_exit_watcher(pid, pane_id_for_thread, inner);
        });

        // child 自体はここで drop されるが、wt.exe は独立プロセスとして走り続ける。
        // Windows の Command::spawn は wait しなくても子プロセスは生き続ける仕様。
        // ただし PID で SYNCHRONIZE 権限の HANDLE を取り直して WaitForSingleObject する形に統一する。
        let _ = child; // drop OK(終了監視は OpenProcess 経由で別途行う)

        Ok(())
    }

    fn update_rect(&self, pane_id: &str, rect: PaneRect) -> Result<(), NativeTerminalError> {
        let mut map = self.inner.lock();
        let handle = match map.get_mut(pane_id) {
            Some(h) => h,
            None => {
                return Err(NativeTerminalError::not_found(format!(
                    "pane not found: {}",
                    pane_id
                )));
            }
        };

        if rects_equal(&handle.last_rect, &rect) {
            return Ok(()); // no-op
        }

        let hwnd = HWND(handle.hwnd as *mut _);
        // 失敗は silent(update_rect は高頻度。ログ汚染を避ける)。
        let _ = apply_rect(hwnd, &rect, handle.visible);
        handle.last_rect = rect;
        Ok(())
    }

    /// メインウィンドウが移動・リサイズしたら全ペインの wt.exe を新しいオフセットで再配置。
    /// 高頻度に呼ばれる前提なので update_rect と同じく失敗は silent。
    fn reapply_all_rects(&self) {
        let map = self.inner.lock();
        for (_pane_id, handle) in map.iter() {
            let hwnd = HWND(handle.hwnd as *mut _);
            let _ = apply_rect(hwnd, &handle.last_rect, handle.visible);
        }
    }

    fn set_visible(&self, pane_id: &str, visible: bool) -> Result<(), NativeTerminalError> {
        let mut map = self.inner.lock();
        let handle = match map.get_mut(pane_id) {
            Some(h) => h,
            None => {
                return Err(NativeTerminalError::not_found(format!(
                    "pane not found: {}",
                    pane_id
                )));
            }
        };

        let hwnd = HWND(handle.hwnd as *mut _);
        unsafe {
            let cmd = if visible { SW_SHOWNOACTIVATE } else { SW_HIDE };
            let _ = ShowWindow(hwnd, cmd);
        }
        handle.visible = visible;
        Ok(())
    }

    fn close(&self, pane_id: &str) -> Result<(), NativeTerminalError> {
        let handle = match self.inner.lock().remove(pane_id) {
            Some(h) => h,
            None => {
                return Err(NativeTerminalError::not_found(format!(
                    "pane not found: {}",
                    pane_id
                )));
            }
        };

        crate::log(&format!(
            "native_terminal/windows: close pane={} pid={} hwnd={:#x}",
            pane_id, handle.pid, handle.hwnd
        ));

        // まず WM_CLOSE で穏便に閉じる試み。失敗したら TerminateProcess へフォールバック。
        let hwnd = HWND(handle.hwnd as *mut _);
        let posted = unsafe { PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0)) };

        if posted.is_err() {
            crate::log(&format!(
                "native_terminal/windows: PostMessageW(WM_CLOSE) failed for pane={}, falling back to TerminateProcess",
                pane_id
            ));
            unsafe {
                if let Ok(proc_handle) = OpenProcess(PROCESS_TERMINATE, false, handle.pid) {
                    if !proc_handle.is_invalid() {
                        let _ = TerminateProcess(proc_handle, 0);
                        let _ = windows::Win32::Foundation::CloseHandle(proc_handle);
                    }
                } else {
                    crate::log(&format!(
                        "native_terminal/windows: OpenProcess(TERMINATE) failed for pid={}",
                        handle.pid
                    ));
                }
            }
        }

        Ok(())
    }

    fn close_all(&self) {
        let pane_ids: Vec<String> = self.inner.lock().keys().cloned().collect();
        crate::log(&format!(
            "native_terminal/windows: close_all ({} panes)",
            pane_ids.len()
        ));
        for id in pane_ids {
            let _ = self.close(&id);
        }
    }

    fn is_available(&self) -> bool {
        // `where wt.exe` の exit status で判定。Windows Terminal 未インストール環境では false。
        match Command::new("where").arg("wt.exe").output() {
            Ok(out) => out.status.success(),
            Err(_) => false,
        }
    }

    fn permission_status(&self) -> Option<String> {
        // Windows では Mac の Accessibility のような追加権限は不要。
        None
    }
}

// ─── プロセス終了監視 ───────────────────────────────────────────────────────

/// wt.exe (実際は PID 指定で OpenProcess した HANDLE) を WaitForSingleObject(INFINITE) し、
/// 終了したらレジストリから削除して native-terminal-exited を emit する。
///
/// Command::spawn() で得た Child はこの時点で drop 済み(独立プロセス化されている)なので、
/// PID から HANDLE を取り直す方式にしている。watcher::watch_child_exit は Child を必要とするため
/// ここでは使わず独自スレッドで待つ(将来 Child を保持する設計に変えるなら watch_child_exit に統一可能)。
fn spawn_exit_watcher(pid: u32, pane_id: String, inner: Arc<Mutex<HashMap<String, TermHandle>>>) {
    thread::spawn(move || {
        unsafe {
            let h = match OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                pid,
            ) {
                Ok(h) if !h.is_invalid() => h,
                _ => {
                    crate::log(&format!(
                        "native_terminal/windows: exit_watcher OpenProcess failed pid={}",
                        pid
                    ));
                    return;
                }
            };

            let _ = WaitForSingleObject(h, INFINITE);
            let _ = windows::Win32::Foundation::CloseHandle(h);
        }

        crate::log(&format!(
            "native_terminal/windows: wt.exe exited pane={} pid={}",
            pane_id, pid
        ));

        // レジストリから取り除く(close() 経由で既に消えている場合は何もしない)。
        inner.lock().remove(&pane_id);
        emit_event("native-terminal-exited", &pane_id, None);
    });
}

// ─── TODO(将来) ────────────────────────────────────────────────────────────
// - メインウィンドウのフォーカス追従: ibis-hub 本体がフォーカスを失った時のみ wt.exe を
//   HWND_BOTTOM に下げるなどの「他アプリ前面化時に重ならない」挙動。現在は常時最前面候補。
// - JobObject で wt.exe を ibis-hub 終了時に強制クリーンアップ(close_all で WM_CLOSE できない
//   ケースの保険)。
// - Per-monitor DPI 変化(WM_DPICHANGED)への追随。現状は spawn 時の scaleFactor を毎回 Frontend
//   から渡し直す前提。
// - wt.exe の起動オプションを設定で切替(profile 名・初期コマンド・shell の選択)。
