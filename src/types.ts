// "xterm" = 既存の xterm.js モード(本線・デフォルト)
// "native" = ネイティブ端末オーバーレイモード(Tauri Win/Mac 限定の試作)
export type TerminalMode = "xterm" | "native";

export interface Session {
  id: string;
  name: string;
  status: string;
  working_dir: string;
  session_type: string;
  terminalMode?: TerminalMode; // optional: 未指定 = "xterm" として扱う(後方互換)
}

export type LayoutMode = "single" | "focus" | "grid";
export type ThemeMode = "dark" | "light";

// ネイティブモード時、ペインの矩形を Rust に通知するための型
export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
}

// 環境判定: ネイティブモードを選べるか
export interface PlatformInfo {
  isTauri: boolean;
  isWsl: boolean;
  isMac: boolean;
  isWindows: boolean;
}
