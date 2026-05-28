// プロセス終了監視ユーティリティ。
//
// 用途: ユーザーが wt.exe / Terminal.app を ibis-hub 経由ではなく**直接**閉じた時、
//      バックエンドがそれを検知して Frontend に "native-terminal-exited" を emit する。
//
// 実装: 各 backend が spawn 時に PID を渡してきて、別スレッドで待つ。
// Win: 別スレッドで `child.wait()` をブロック。Mac: 同じく `child.wait()`。
// プロセスが終了したら on_exit を呼んでくれる。
//
// なお Tauri の `AppHandle::emit` をどこで呼ぶかは呼び出し側の責任。
// このモジュールは pure な「終了を待って callback を呼ぶ」だけを担う。

use std::process::Child;
use std::thread;

/// 子プロセスの終了を別スレッドで監視し、終了時に on_exit を呼ぶ。
/// 呼び出し側は Child の所有権を渡すこと(待つ間に dropされて wait pid が消えるのを防ぐため)。
pub fn watch_child_exit(mut child: Child, pane_id: String, on_exit: impl FnOnce(&str) + Send + 'static) {
    thread::spawn(move || {
        let _ = child.wait();
        on_exit(&pane_id);
    });
}
