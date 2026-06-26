/**
 * Lightweight attention notifications for when an AI session needs you:
 * desktop notification + a short sound + (handled elsewhere) a tab-title badge.
 *
 * Kept dependency-free so it works in both the browser and the Tauri webview.
 */

let permissionAsked = false;

/** Ask for desktop-notification permission once, ideally after a user gesture. */
export function ensureNotifyPermission(): void {
  if (permissionAsked) return;
  permissionAsked = true;
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  } catch {}
}

/** Show a desktop notification (no-op if not permitted / unsupported). */
export function notifyDesktop(title: string, body: string): void {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      const n = new Notification(title, { body, tag: "ibis-hub" });
      // Focus the window when the user clicks the notification.
      n.onclick = () => {
        try { window.focus(); } catch {}
        n.close();
      };
    }
  } catch {}
}

// Reuse a single AudioContext so we don't leak one per beep.
let audioCtx: AudioContext | null = null;

/** Play a short, gentle two-tone chime to signal "a session needs you". */
export function playChime(): void {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    const ctx = audioCtx;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    const now = ctx.currentTime;
    const tones = [880, 1175]; // A5 → D6, a friendly "ding-dong"
    tones.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + i * 0.16;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.15);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.16);
    });
  } catch {}
}

/** Fire all attention signals at once. */
export function notifyAttention(title: string, body: string): void {
  notifyDesktop(title, body);
  playChime();
}
