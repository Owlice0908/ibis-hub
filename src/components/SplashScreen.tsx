import { useEffect, useRef } from "react";

interface Star {
  x: number;
  y: number;
  size: number;
  brightness: number;
  twinkleSpeed: number;
  twinkleOffset: number;
}

interface NebulaWisp {
  x: number;
  y: number;
  width: number;
  drift: number;
  speed: number;
  hue: number;
  alpha: number;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  life: number;
  maxLife: number;
  hue: number;
}

const DURATION = 5600;
const PHASE = {
  FLIGHT_START: 250,
  FLIGHT_END: 3050,
  TEXT_START: 3200,
  TEXT_DONE: 3800,
  HOLD_END: 4550,
  FADE_END: DURATION,
};

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

function drawFaviconBird(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  scale: number,
  alpha: number,
  rotation: number,
  trail = false,
) {
  const originX = 1000;
  const originY = 900;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.scale(scale, scale);
  ctx.globalAlpha *= alpha;
  ctx.globalCompositeOperation = trail ? "lighter" : "source-over";

  if (trail) {
    ctx.filter = "blur(1px)";
  }

  if (!trail) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha *= 0.14;
    ctx.filter = "blur(10px)";
    ctx.drawImage(img, (0 - originX) * 1.02, (0 - originY) * 1.02, img.naturalWidth * 1.02, img.naturalHeight * 1.02);
    ctx.restore();
  }

  ctx.drawImage(img, -originX, -originY, img.naturalWidth, img.naturalHeight);
  ctx.restore();
}

export default function SplashScreen({ onDone }: { onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = window.innerWidth;
    const H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.scale(dpr, dpr);

    const cx = W / 2;
    const cy = H / 2 - 24;
    const baseScale = Math.min(W, H) / 4250;

    const stars: Star[] = [];
    for (let i = 0; i < 420; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        size: Math.random() > 0.88 ? 1.2 + Math.random() * 1.2 : 0.25 + Math.random() * 0.9,
        brightness: 0.18 + Math.random() * 0.82,
        twinkleSpeed: 0.35 + Math.random() * 2.4,
        twinkleOffset: Math.random() * Math.PI * 2,
      });
    }

    const wisps: NebulaWisp[] = [];
    for (let i = 0; i < 7; i++) {
      wisps.push({
        x: Math.random() * W,
        y: H * (0.08 + Math.random() * 0.78),
        width: W * (0.28 + Math.random() * 0.38),
        drift: Math.random() * Math.PI * 2,
        speed: 0.00008 + Math.random() * 0.00012,
        hue: Math.random() > 0.78 ? 28 : 195 + Math.random() * 18,
        alpha: 0.018 + Math.random() * 0.03,
      });
    }

    const sparks: Spark[] = [];
    const logoImg = new Image();
    logoImg.src = "/logo-refined-balanced.png";

    const start = performance.now();
    let animId = 0;

    function render(now: number) {
      const elapsed = now - start;
      if (elapsed >= DURATION) {
        if (!doneRef.current) {
          doneRef.current = true;
          onDone();
        }
        return;
      }
      if (!ctx) return;

      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.86);
      bg.addColorStop(0, "#05090c");
      bg.addColorStop(0.48, "#020405");
      bg.addColorStop(1, "#000000");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      const ambient = ctx.createRadialGradient(W * 0.28, H * 0.18, 0, W * 0.28, H * 0.18, Math.max(W, H) * 0.62);
      ambient.addColorStop(0, "rgba(28, 86, 102, 0.13)");
      ambient.addColorStop(0.54, "rgba(12, 30, 38, 0.055)");
      ambient.addColorStop(1, "transparent");
      ctx.fillStyle = ambient;
      ctx.fillRect(0, 0, W, H);

      const warmth = ctx.createRadialGradient(W * 0.72, H * 0.74, 0, W * 0.72, H * 0.74, Math.max(W, H) * 0.58);
      warmth.addColorStop(0, "rgba(183, 87, 67, 0.055)");
      warmth.addColorStop(0.42, "rgba(104, 52, 36, 0.028)");
      warmth.addColorStop(1, "transparent");
      ctx.fillStyle = warmth;
      ctx.fillRect(0, 0, W, H);

      const fadeOut = elapsed > PHASE.HOLD_END
        ? 1 - (elapsed - PHASE.HOLD_END) / (PHASE.FADE_END - PHASE.HOLD_END)
        : 1;

      ctx.save();
      ctx.globalCompositeOperation = "screen";
      wisps.forEach((wisp, index) => {
        const t = elapsed * wisp.speed + wisp.drift;
        const bx = (wisp.x + Math.sin(t) * W * 0.035 + elapsed * 0.004 * (index % 2 ? 1 : -1)) % (W + wisp.width);
        const by = wisp.y + Math.cos(t * 0.8) * H * 0.028;
        const gradient = ctx.createLinearGradient(bx - wisp.width, by - 90, bx + wisp.width, by + 90);
        gradient.addColorStop(0, "transparent");
        gradient.addColorStop(0.5, `hsla(${wisp.hue}, 58%, 54%, ${wisp.alpha * fadeOut})`);
        gradient.addColorStop(1, "transparent");
        ctx.strokeStyle = gradient;
        ctx.lineWidth = Math.max(42, Math.min(W, H) * 0.078);
        ctx.filter = "blur(12px)";
        ctx.beginPath();
        ctx.moveTo(bx - wisp.width, by + Math.sin(t) * 36);
        ctx.bezierCurveTo(
          bx - wisp.width * 0.25,
          by - H * 0.12,
          bx + wisp.width * 0.28,
          by + H * 0.12,
          bx + wisp.width,
          by + Math.cos(t) * 42,
        );
        ctx.stroke();
      });
      ctx.restore();

      const starAlpha = Math.min(1, elapsed / 800) * fadeOut;
      stars.forEach((s) => {
        const twinkle = 0.5 + 0.5 * Math.sin(elapsed * 0.001 * s.twinkleSpeed + s.twinkleOffset);
        ctx.globalAlpha = s.brightness * twinkle * starAlpha;
        ctx.fillStyle = s.size > 1.2 ? "#f1f7ff" : "#b8ccd8";
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;

      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.strokeStyle = `rgba(191, 221, 235, ${0.16 * fadeOut})`;
      ctx.lineWidth = 1.2;
      for (let i = 0; i < 3; i++) {
        const period = 2600 + i * 900;
        const p = ((elapsed + i * 850) % period) / period;
        if (p < 0.42) {
          const sx = W * (0.12 + i * 0.26) + p * W * 0.55;
          const sy = H * (0.14 + i * 0.18) + p * H * 0.18;
          ctx.globalAlpha = Math.sin((p / 0.42) * Math.PI) * 0.45 * fadeOut;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(sx - 86, sy - 28);
          ctx.stroke();
        }
      }
      ctx.restore();

      if (!logoImg.complete || logoImg.naturalWidth === 0) {
        animId = requestAnimationFrame(render);
        return;
      }

      const flightProgress = Math.max(
        0,
        Math.min(1, (elapsed - PHASE.FLIGHT_START) / (PHASE.FLIGHT_END - PHASE.FLIGHT_START)),
      );
      const flight = easeInOut(flightProgress);
      const hold = Math.max(0, Math.min(1, (elapsed - PHASE.FLIGHT_END) / 620));

      const startX = -Math.min(W, H) * 0.24;
      const startY = cy + Math.min(H * 0.18, 120);
      const targetX = cx;
      const targetY = cy - Math.min(H * 0.02, 16);
      const arc = Math.sin(flight * Math.PI) * Math.min(H * 0.17, 110);
      const birdX = startX + (targetX - startX) * flight;
      const birdY = startY + (targetY - startY) * flight - arc;
      const birdScale = baseScale * (0.42 + flight * 0.74 + Math.sin(flight * Math.PI) * 0.06);
      const birdRot = (-14 + flight * 12) * (Math.PI / 180);
      const alpha = Math.min(1, flightProgress * 1.5) * fadeOut;

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let i = 7; i >= 1; i--) {
        drawFaviconBird(
          ctx,
          logoImg,
          birdX - i * 22,
          birdY + i * 8,
          birdScale * (1 - i * 0.025),
          alpha * (0.035 + (i / 7) * 0.035) * (1 - flight * 0.25),
          birdRot - i * 0.012,
          true,
        );
      }
      ctx.restore();

      if (flightProgress > 0.04 && flightProgress < 0.96) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = (1 - flight) * 0.36 * alpha;
        ctx.strokeStyle = "rgba(104, 155, 180, 0.85)";
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 16; i++) {
          const lineY = birdY - 76 * birdScale + i * 12 * birdScale;
          const lineX = birdX - 178 * birdScale - i * 3;
          ctx.beginPath();
          ctx.moveTo(lineX, lineY);
          ctx.lineTo(lineX - (72 + i * 4) * birdScale, lineY + 10 * birdScale);
          ctx.stroke();
        }
        ctx.restore();
      }

      const glow = ctx.createRadialGradient(birdX, birdY, 0, birdX, birdY, 520 * birdScale);
      glow.addColorStop(0, `rgba(90, 155, 184, ${0.13 * alpha})`);
      glow.addColorStop(0.58, `rgba(245, 158, 11, ${0.055 * alpha})`);
      glow.addColorStop(1, "transparent");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);

      drawFaviconBird(ctx, logoImg, birdX, birdY, birdScale, alpha, birdRot);

      if (elapsed >= PHASE.FLIGHT_END && elapsed < PHASE.FLIGHT_END + 240 && sparks.length < 70) {
        for (let i = 0; i < 4; i++) {
          const angle = Math.random() * Math.PI * 2;
          const speed = 1.5 + Math.random() * 4.5;
          sparks.push({
            x: cx,
            y: cy,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            size: 1 + Math.random() * 2,
            life: 0,
            maxLife: 42 + Math.random() * 24,
            hue: Math.random() > 0.72 ? 38 : 196,
          });
        }
      }

      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.x += s.vx;
        s.y += s.vy;
        s.vx *= 0.97;
        s.vy *= 0.97;
        s.life++;
        if (s.life >= s.maxLife) {
          sparks.splice(i, 1);
          continue;
        }
        const p = s.life / s.maxLife;
        const a = (p < 0.2 ? p / 0.2 : 1 - (p - 0.2) / 0.8) * fadeOut;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${s.hue}, 78%, 70%, ${a * 0.75})`;
        ctx.fill();
      }

      if (hold > 0) {
        ctx.save();
        ctx.globalCompositeOperation = "screen";
        ctx.globalAlpha = Math.sin(hold * Math.PI) * 0.18 * fadeOut;
        ctx.strokeStyle = "rgba(245, 158, 11, 0.72)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(cx, cy, 124 * baseScale * 2.8, 70 * baseScale * 2.8, -0.08, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      const textProgress = Math.max(
        0,
        Math.min(1, (elapsed - PHASE.TEXT_START) / (PHASE.TEXT_DONE - PHASE.TEXT_START)),
      );
      if (textProgress > 0) {
        const textAlpha = easeOut(textProgress) * fadeOut;
        ctx.save();
        ctx.globalAlpha = textAlpha;
        ctx.textAlign = "center";
        ctx.fillStyle = "#e5eef5";
        ctx.font = "600 28px Inter, system-ui, sans-serif";
        ctx.fillText("IBIS HUB", cx, cy + 128 * baseScale * 2.8);
        ctx.fillStyle = "#8ea3ad";
        ctx.font = "400 11px Inter, system-ui, sans-serif";
        ctx.fillText("MULTI-SESSION MANAGER", cx, cy + 152 * baseScale * 2.8);
        ctx.restore();
      }

      animId = requestAnimationFrame(render);
    }

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [onDone]);

  return <canvas ref={canvasRef} className="splash-screen fixed inset-0 z-50" />;
}
