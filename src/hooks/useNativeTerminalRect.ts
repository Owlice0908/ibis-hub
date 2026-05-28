// ペインの DOM 矩形を ResizeObserver + window スクロール監視で追跡し、
// requestAnimationFrame で 1 フレーム単位に間引いて Rust 側に通知する hook。
// invoke は呼び出し側から渡してもらう("xterm モードでは呼ばない" を強制するため)。
import { useEffect, useRef } from "react";
import type { PaneRect } from "../types";

// 矩形差が threshold(px) 未満なら invoke をスキップ
const MIN_RECT_DELTA_PX = 1.0;

function rectChanged(a: PaneRect | null, b: PaneRect): boolean {
  if (!a) return true;
  return (
    Math.abs(a.x - b.x) >= MIN_RECT_DELTA_PX ||
    Math.abs(a.y - b.y) >= MIN_RECT_DELTA_PX ||
    Math.abs(a.width - b.width) >= MIN_RECT_DELTA_PX ||
    Math.abs(a.height - b.height) >= MIN_RECT_DELTA_PX ||
    a.scaleFactor !== b.scaleFactor
  );
}

export interface UseNativeTerminalRectOptions {
  // ペインのルート要素(getBoundingClientRect する対象)
  paneRef: React.RefObject<HTMLDivElement | null>;
  // セッション ID(Rust 側のキー)
  paneId: string;
  // この hook を有効化する条件(Tauri + native モード + isVisible 等を呼び出し側で合成)
  active: boolean;
  // Rust 側 update_native_terminal_rect を呼ぶコールバック
  onRectChange: (paneId: string, rect: PaneRect) => void;
}

export function useNativeTerminalRect(opts: UseNativeTerminalRectOptions): void {
  const { paneRef, paneId, active, onRectChange } = opts;
  const lastRectRef = useRef<PaneRect | null>(null);
  const rafScheduledRef = useRef<boolean>(false);

  useEffect(() => {
    if (!active) {
      lastRectRef.current = null;
      return;
    }
    const el = paneRef.current;
    if (!el) return;

    const compute = () => {
      rafScheduledRef.current = false;
      const node = paneRef.current;
      if (!node) return;
      const r = node.getBoundingClientRect();
      const next: PaneRect = {
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
        scaleFactor: window.devicePixelRatio || 1,
      };
      if (rectChanged(lastRectRef.current, next)) {
        lastRectRef.current = next;
        try {
          onRectChange(paneId, next);
        } catch {
          // Tauri invoke の失敗は呼び出し側で扱う
        }
      }
    };

    const schedule = () => {
      if (rafScheduledRef.current) return;
      rafScheduledRef.current = true;
      requestAnimationFrame(compute);
    };

    // 初回同期
    schedule();

    // ペイン自身のサイズ変化
    const ro = new ResizeObserver(schedule);
    ro.observe(el);

    // ウィンドウサイズ・スクロールでペイン絶対座標も変わる
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      lastRectRef.current = null;
    };
  }, [active, paneId, paneRef, onRectChange]);
}
