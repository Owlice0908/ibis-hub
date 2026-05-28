// 実行環境判定と TerminalMode の解決を担当する純粋関数モジュール。
// Tauri デスクトップ版(Win/Mac)でのみ Native モードを許可し、それ以外では xterm にフォールバック。
import type { PlatformInfo, TerminalMode } from "../types";

// Tauri ランタイムが存在するか(モジュールロード時に1回だけ評価される)
export const isTauriRuntime: boolean =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// 起動時の navigator ベース粗判定。Tauri 経由で確定値を取れたら上書きする想定。
export function detectInitialPlatform(): PlatformInfo {
  const ua = typeof navigator !== "undefined" ? navigator.platform.toLowerCase() : "";
  return {
    isTauri: isTauriRuntime,
    isWsl: false, // Tauri get_platform() で確定
    isMac: isTauriRuntime && ua.includes("mac"),
    isWindows: isTauriRuntime && (ua.includes("win") && !ua.includes("mac")),
  };
}

// Tauri get_platform() の戻り値("wsl"|"windows"|"macos"|"linux")で確定値に更新
export function refinePlatformFromTauri(prev: PlatformInfo, platform: string): PlatformInfo {
  return {
    ...prev,
    isWsl: platform === "wsl",
    isWindows: platform === "windows" || platform === "wsl",
    isMac: platform === "macos",
  };
}

// Native モードを選択可能か。ブラウザ運用では常に false。
export function isNativeTerminalAvailable(platform: PlatformInfo): boolean {
  if (!platform.isTauri) return false;
  return platform.isWsl || platform.isWindows || platform.isMac;
}

// セッションの要求モードと環境から、実際に使うモードを決定。
// ブラウザ版で "native" が残っていた場合は xterm に降格し degraded=true を返す。
export function resolveTerminalMode(
  requested: TerminalMode | undefined,
  platform: PlatformInfo,
): { mode: TerminalMode; degraded: boolean } {
  const mode: TerminalMode = requested ?? "xterm";
  if (mode === "native" && !isNativeTerminalAvailable(platform)) {
    return { mode: "xterm", degraded: true };
  }
  return { mode, degraded: false };
}
