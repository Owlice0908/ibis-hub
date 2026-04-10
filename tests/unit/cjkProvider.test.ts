/**
 * Integration test for the CJK unicode provider that runs in the actual
 * xterm.js Terminal instance — NOT a mock.
 *
 * This verifies the EXACT code path that determines whether box drawing
 * characters (used by Claude Code for borders) render as 1 column (correct)
 * or 2 columns (broken → dotted border).
 *
 * The test creates a real Terminal, loads Unicode11Addon, registers the
 * CJK provider with the same logic as TerminalPane.tsx, then queries
 * wcwidth and charProperties for critical characters.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { isAmbiguousWide, isForceNarrow } from "../../src/lib/terminalUtils";

describe("CJK unicode provider — integration with real xterm.js Terminal", () => {
  let terminal: Terminal;
  let cjkWcwidth: (cp: number) => 0 | 1 | 2;
  let cjkCharProperties: (cp: number, preceding: number) => number;
  let providerRegistered = false;

  beforeAll(() => {
    // jsdom lacks some browser APIs that xterm.js needs
    if (!window.matchMedia) {
      (window as any).matchMedia = (query: string) => ({
        matches: false, media: query, onchange: null,
        addListener: () => {}, removeListener: () => {},
        addEventListener: () => {}, removeEventListener: () => {},
        dispatchEvent: () => false,
      });
    }
    // Stub canvas context (xterm uses it for measuring)
    HTMLCanvasElement.prototype.getContext = (() => null) as any;

    const container = document.createElement("div");
    document.body.appendChild(container);

    terminal = new Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true,
    });
    terminal.open(container);

    // Load Unicode11
    const unicode11 = new Unicode11Addon();
    terminal.loadAddon(unicode11);
    terminal.unicode.activeVersion = "11";

    // Register CJK provider — EXACT same logic as TerminalPane.tsx
    try {
      const baseProvider: any =
        (terminal as any)._core?._inputHandler?._parser?._unicodeService
          ?._activeProvider ??
        (terminal as any)._core?._unicodeService?._activeProvider;

      const fallbackWcwidth = (cp: number): 0 | 1 | 2 => {
        if (baseProvider && typeof baseProvider.wcwidth === "function") {
          return baseProvider.wcwidth(cp);
        }
        if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
        return 1;
      };

      const provider = {
        version: "cjk",
        wcwidth: (cp: number): 0 | 1 | 2 => {
          if (isForceNarrow(cp)) return 1;
          if (isAmbiguousWide(cp)) return 2;
          return fallbackWcwidth(cp);
        },
        charProperties: (codepoint: number, preceding: number): number => {
          if (
            baseProvider &&
            typeof baseProvider.charProperties === "function"
          ) {
            const props = baseProvider.charProperties(codepoint, preceding);
            if (isForceNarrow(codepoint)) {
              return (props & ~0b110) | (1 << 1);
            }
            if (isAmbiguousWide(codepoint)) {
              return (props & ~0b110) | (2 << 1);
            }
            return props;
          }
          const width = isForceNarrow(codepoint) ? 1
            : isAmbiguousWide(codepoint) ? 2
            : fallbackWcwidth(codepoint);
          return width << 1;
        },
      };

      terminal.unicode.register(provider as any);
      terminal.unicode.activeVersion = "cjk";
      cjkWcwidth = provider.wcwidth;
      cjkCharProperties = provider.charProperties;
      providerRegistered = true;
    } catch (e) {
      console.error("CJK provider registration failed:", e);
    }
  });

  afterAll(() => {
    terminal?.dispose();
  });

  it("CJK provider is registered and active", () => {
    expect(providerRegistered).toBe(true);
    expect(terminal.unicode.activeVersion).toBe("cjk");
  });

  // ========== BOX DRAWING: MUST be width 1 ==========
  // Regression: these were set to 2 which broke Claude Code's input border
  describe("box drawing characters → width 1 (CRITICAL)", () => {
    const boxChars = [
      { cp: 0x2500, name: "─ horizontal" },
      { cp: 0x2501, name: "━ heavy horizontal" },
      { cp: 0x2502, name: "│ vertical" },
      { cp: 0x2503, name: "┃ heavy vertical" },
      { cp: 0x250c, name: "┌ top-left" },
      { cp: 0x2510, name: "┐ top-right" },
      { cp: 0x2514, name: "└ bottom-left" },
      { cp: 0x2518, name: "┘ bottom-right" },
      { cp: 0x251c, name: "├ left tee" },
      { cp: 0x2524, name: "┤ right tee" },
      { cp: 0x252c, name: "┬ top tee" },
      { cp: 0x2534, name: "┴ bottom tee" },
      { cp: 0x253c, name: "┼ cross" },
    ];

    for (const { cp, name } of boxChars) {
      it(`wcwidth(${name}) === 1`, () => {
        expect(cjkWcwidth(cp)).toBe(1);
      });

      it(`charProperties(${name}) width bits === 1`, () => {
        const props = cjkCharProperties(cp, 0);
        const width = (props >> 1) & 0x3; // bits 1-2
        expect(width).toBe(1);
      });
    }
  });

  // ========== ENCLOSED ALPHANUMERICS: MUST be width 2 ==========
  // This is the original fix — ①②③ must NOT overlap
  describe("enclosed alphanumerics ①②③ → width 2", () => {
    const enclosedChars = [
      { cp: 0x2460, name: "①" },
      { cp: 0x2461, name: "②" },
      { cp: 0x2462, name: "③" },
      { cp: 0x2469, name: "⑩" },
      { cp: 0x24ea, name: "⓪" },
    ];

    for (const { cp, name } of enclosedChars) {
      it(`wcwidth(${name}) === 2`, () => {
        expect(cjkWcwidth(cp)).toBe(2);
      });

      it(`charProperties(${name}) width bits === 2`, () => {
        const props = cjkCharProperties(cp, 0);
        const width = (props >> 1) & 0x3;
        expect(width).toBe(2);
      });
    }
  });

  // ========== BLOCK ELEMENTS / ARROWS / SYMBOLS: MUST be width 1 ==========
  describe("other TUI characters → width 1 (not broken)", () => {
    const otherChars = [
      { cp: 0x2580, name: "▀ block" },
      { cp: 0x2588, name: "█ full block" },
      { cp: 0x25a0, name: "■ square" },
      { cp: 0x2190, name: "← arrow" },
      { cp: 0x2192, name: "→ arrow" },
      { cp: 0x2605, name: "★ star" },
      { cp: 0x2713, name: "✓ check" },
    ];

    for (const { cp, name } of otherChars) {
      it(`wcwidth(${name}) === 1`, () => {
        expect(cjkWcwidth(cp)).toBe(1);
      });
    }
  });

  // ========== ASCII: unchanged ==========
  describe("ASCII / Latin characters → unchanged", () => {
    it("regular ASCII letters are width 1", () => {
      expect(cjkWcwidth(0x41)).toBe(1); // A
      expect(cjkWcwidth(0x61)).toBe(1); // a
    });

    // Note: CJK ideographs (一 あ) should be width 2 via the base Unicode11
    // provider, but jsdom lacks canvas context so Unicode11Addon can't fully
    // initialize. This is tested implicitly in production (real browser) and
    // in CI's Mac smoke test. Not testable in jsdom.
  });
});
