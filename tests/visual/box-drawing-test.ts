import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

const terminal = new Terminal({
  fontFamily: "'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Source Han Mono', 'Noto Sans Mono CJK JP', 'MS Gothic', monospace",
  fontSize: 14,
  cols: 60,
  rows: 12,
  theme: { background: "#0f0f0f", foreground: "#e5e5e5" },
});

terminal.open(document.getElementById("terminal")!);

// Same fixed-box provider as TerminalPane.tsx
try {
  const baseProvider: any = (terminal as any)._core?._unicodeService?._activeProvider;
  if (baseProvider) {
    const fixedProvider = {
      version: "fixed-box",
      wcwidth: (cp: number): 0 | 1 | 2 => {
        if (cp >= 0x2500 && cp <= 0x259f) return 1;
        return baseProvider.wcwidth(cp);
      },
      charProperties: (codepoint: number, preceding: number): number => {
        if (baseProvider.charProperties) {
          const props = baseProvider.charProperties(codepoint, preceding);
          if (codepoint >= 0x2500 && codepoint <= 0x259f) {
            return (props & ~0b110) | (1 << 1);
          }
          return props;
        }
        const w = (codepoint >= 0x2500 && codepoint <= 0x259f) ? 1 : baseProvider.wcwidth(codepoint);
        return (w << 1);
      },
    };
    terminal.unicode.register(fixedProvider as any);
    terminal.unicode.activeVersion = "fixed-box";
    document.getElementById("status")!.textContent += "Provider: fixed-box active\n";
  }
} catch (e) {
  document.getElementById("status")!.textContent += "Provider: FAILED " + e + "\n";
}

terminal.write("=== Box Drawing Test (should be SOLID lines) ===\r\n\r\n");
terminal.write("┌──────────────────────────────────────────────────┐\r\n");
terminal.write("│ This is an input box (like Claude Code)         │\r\n");
terminal.write("└──────────────────────────────────────────────────┘\r\n");
terminal.write("\r\n");
terminal.write("────────────────────────────────────────────────────\r\n");
terminal.write("❯ cursor here\r\n");
terminal.write("────────────────────────────────────────────────────\r\n");

(window as any).__TEST_DONE__ = true;
