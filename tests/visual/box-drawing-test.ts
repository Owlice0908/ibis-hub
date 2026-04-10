import { Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";

const terminal = new Terminal({
  fontFamily: "'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Source Han Mono', 'Noto Sans Mono CJK JP', 'MS Gothic', monospace",
  fontSize: 14,
  cols: 60,
  rows: 16,
  theme: { background: "#0f0f0f", foreground: "#e5e5e5" },
});

terminal.open(document.getElementById("terminal")!);

// Same as v0.2.16: Unicode11Addon only, no custom providers
const unicode11Addon = new Unicode11Addon();
terminal.loadAddon(unicode11Addon);
terminal.unicode.activeVersion = "11";

terminal.write("=== Box Drawing Test (should be SOLID lines) ===\r\n\r\n");
terminal.write("┌──────────────────────────────────────────────────┐\r\n");
terminal.write("│ This is an input box (like Claude Code)         │\r\n");
terminal.write("└──────────────────────────────────────────────────┘\r\n");
terminal.write("\r\n");
terminal.write("────────────────────────────────────────────────────\r\n");
terminal.write("❯ cursor here\r\n");
terminal.write("────────────────────────────────────────────────────\r\n");
terminal.write("\r\n");
terminal.write("=== CJK / overlap test ===\r\n");
terminal.write("日本語テスト abcdef 12345\r\n");
terminal.write("①②③④⑤ テスト test\r\n");
terminal.write("あいうえお カキクケコ ABC\r\n");
terminal.write("混在テスト: Hello世界！foo①bar②baz\r\n");

(window as any).__TEST_DONE__ = true;
