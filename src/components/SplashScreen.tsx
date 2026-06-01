import { useEffect, useRef } from "react";
import appIcon from "../assets/logo-hd.png";

interface Star {
  x: number;
  y: number;
  size: number;
  brightness: number;
  twinkleSpeed: number;
  twinkleOffset: number;
}

interface LogoParticle {
  targetX: number;
  targetY: number;
  x: number;
  y: number;
  originX: number;
  originY: number;
  size: number;
  hue: number;
  delay: number;
  arrived: boolean;
  trailX: number[];
  trailY: number[];
}

interface BurstParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  life: number;
  maxLife: number;
  hue: number;
}

const DURATION = 5000;

const PHASE = {
  STARS: 0,
  CONVERGE_START: 600,
  CONVERGE_END: 2800,
  GLOW_PEAK: 3200,
  TEXT_START: 3000,
  TEXT_DONE: 3500,
  BURST: 3100,
  HOLD_END: 4200,
  FADE_END: DURATION,
};

function sampleImagePoints(
  img: HTMLImageElement,
  count: number,
  alphaThreshold = 128,
): { x: number; y: number; size: number }[] {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  const opaque: { x: number; y: number }[] = [];
  const step = 2;
  for (let y = 0; y < canvas.height; y += step) {
    for (let x = 0; x < canvas.width; x += step) {
      const idx = (y * canvas.width + x) * 4;
      if (data[idx + 3] > alphaThreshold) {
        opaque.push({ x, y });
      }
    }
  }

  if (opaque.length === 0) return [];

  const out: { x: number; y: number; size: number }[] = [];
  if (opaque.length <= count) {
    opaque.forEach((p) => out.push({ x: p.x, y: p.y, size: 1.2 + Math.random() * 1.8 }));
    return out;
  }
  const stride = opaque.length / count;
  for (let i = 0; i < count; i++) {
    const p = opaque[Math.floor(i * stride)];
    out.push({ x: p.x, y: p.y, size: 1.2 + Math.random() * 1.8 });
  }
  return out;
}

export default function SplashScreen({ onDone }: { onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;

    const dpr = window.devicePixelRatio || 1;
    const W = window.innerWidth;
    const H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    const cx = W / 2;
    const cy = H / 2 - 20;

    const stars: Star[] = [];
    for (let i = 0; i < 200; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        size: 0.3 + Math.random() * 1.5,
        brightness: 0.3 + Math.random() * 0.7,
        twinkleSpeed: 0.5 + Math.random() * 2,
        twinkleOffset: Math.random() * Math.PI * 2,
      });
    }

    const logoParticles: LogoParticle[] = [];
    const burstParticles: BurstParticle[] = [];

    const textStr = "IBIS HUB";
    const subText = "MULTI-SESSION MANAGER";

    const easeInOut = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

    let animId = 0;
    let start = 0;
    let logoImg: HTMLImageElement | null = null;
    let logoDisplaySize = 0;
    let logoOffsetX = 0;
    let logoOffsetY = 0;
    let imgNaturalW = 0;
    let imgNaturalH = 0;

    function render(now: number) {
      if (!start) start = now;
      const elapsed = now - start;
      if (elapsed >= DURATION) {
        if (!doneRef.current) {
          doneRef.current = true;
          onDone();
        }
        return;
      }

      ctx.fillStyle = "#0b0e11";
      ctx.fillRect(0, 0, W, H);

      const starAlpha = Math.min(1, elapsed / 800);
      stars.forEach((s) => {
        const twinkle =
          0.5 + 0.5 * Math.sin(elapsed * 0.001 * s.twinkleSpeed + s.twinkleOffset);
        const a = s.brightness * twinkle * starAlpha;
        if (elapsed > PHASE.HOLD_END) {
          const fadeProgress = (elapsed - PHASE.HOLD_END) / (PHASE.FADE_END - PHASE.HOLD_END);
          ctx.globalAlpha = a * (1 - fadeProgress);
        } else {
          ctx.globalAlpha = a;
        }
        ctx.fillStyle = "#c8dce8";
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;

      const convergeProgress = Math.max(
        0,
        Math.min(1, (elapsed - PHASE.CONVERGE_START) / (PHASE.CONVERGE_END - PHASE.CONVERGE_START)),
      );

      logoParticles.forEach((p) => {
        const adjustedProgress = Math.max(
          0,
          Math.min(1, (convergeProgress - p.delay) / (1 - p.delay)),
        );
        const eased = easeInOut(adjustedProgress);

        p.x = p.originX + (p.targetX - p.originX) * eased;
        p.y = p.originY + (p.targetY - p.originY) * eased;

        p.trailX.push(p.x);
        p.trailY.push(p.y);
        if (p.trailX.length > 8) {
          p.trailX.shift();
          p.trailY.shift();
        }

        p.arrived = adjustedProgress > 0.95;

        if (adjustedProgress > 0 && adjustedProgress < 0.95) {
          for (let i = 0; i < p.trailX.length - 1; i++) {
            const ta = (i / p.trailX.length) * 0.3;
            ctx.beginPath();
            ctx.arc(p.trailX[i], p.trailY[i], p.size * 0.5, 0, Math.PI * 2);
            ctx.fillStyle = `hsla(${p.hue}, 80%, 75%, ${ta})`;
            ctx.fill();
          }
        }

        let alpha = adjustedProgress > 0 ? 0.8 : 0;
        if (p.arrived) {
          const glowT = Math.max(
            0,
            Math.min(1, (elapsed - PHASE.CONVERGE_END) / (PHASE.GLOW_PEAK - PHASE.CONVERGE_END)),
          );
          alpha = 0.8 + glowT * 0.2;
        }

        if (elapsed > PHASE.HOLD_END) {
          const fadeT = (elapsed - PHASE.HOLD_END) / (PHASE.FADE_END - PHASE.HOLD_END);
          alpha *= 1 - fadeT;
        }

        if (alpha <= 0) return;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${p.hue}, 70%, 72%, ${alpha})`;
        ctx.fill();

        if (p.arrived) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * 3, 0, Math.PI * 2);
          ctx.fillStyle = `hsla(${p.hue}, 70%, 72%, ${alpha * 0.15})`;
          ctx.fill();
        }
      });

      const allArrived = convergeProgress >= 1;

      if (allArrived && logoImg) {
        const glowT = Math.max(
          0,
          Math.min(1, (elapsed - PHASE.CONVERGE_END) / (PHASE.GLOW_PEAK - PHASE.CONVERGE_END)),
        );
        const glowEased = easeOut(glowT);

        let glowAlpha = glowEased * 0.25;
        if (elapsed > PHASE.HOLD_END) {
          const fadeT = (elapsed - PHASE.HOLD_END) / (PHASE.FADE_END - PHASE.HOLD_END);
          glowAlpha *= 1 - fadeT;
        }

        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, logoDisplaySize * 0.9);
        grad.addColorStop(0, `rgba(100, 180, 220, ${glowAlpha})`);
        grad.addColorStop(0.5, `rgba(100, 180, 220, ${glowAlpha * 0.3})`);
        grad.addColorStop(1, "transparent");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);

        let iconAlpha = glowEased;
        if (elapsed > PHASE.HOLD_END) {
          const fadeT = (elapsed - PHASE.HOLD_END) / (PHASE.FADE_END - PHASE.HOLD_END);
          iconAlpha *= 1 - fadeT;
        }
        if (iconAlpha > 0) {
          ctx.globalAlpha = iconAlpha;
          ctx.drawImage(logoImg, logoOffsetX, logoOffsetY, logoDisplaySize, logoDisplaySize);
          ctx.globalAlpha = 1;
        }
      }

      if (elapsed >= PHASE.BURST && elapsed < PHASE.BURST + 200 && burstParticles.length < 60) {
        for (let i = 0; i < 5; i++) {
          const angle = Math.random() * Math.PI * 2;
          const speed = 2 + Math.random() * 5;
          burstParticles.push({
            x: cx,
            y: cy,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            size: 1 + Math.random() * 2,
            life: 0,
            maxLife: 40 + Math.random() * 30,
            hue: 190 + Math.random() * 30,
          });
        }
      }

      for (let i = burstParticles.length - 1; i >= 0; i--) {
        const bp = burstParticles[i];
        bp.x += bp.vx;
        bp.y += bp.vy;
        bp.vx *= 0.97;
        bp.vy *= 0.97;
        bp.life++;
        if (bp.life >= bp.maxLife) {
          burstParticles.splice(i, 1);
          continue;
        }
        const prog = bp.life / bp.maxLife;
        let a = prog < 0.2 ? prog / 0.2 : 1 - (prog - 0.2) / 0.8;
        if (elapsed > PHASE.HOLD_END) {
          const fadeT = (elapsed - PHASE.HOLD_END) / (PHASE.FADE_END - PHASE.HOLD_END);
          a *= 1 - fadeT;
        }
        ctx.beginPath();
        ctx.arc(bp.x, bp.y, bp.size, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${bp.hue}, 70%, 70%, ${a * 0.8})`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(bp.x, bp.y, bp.size * 2.5, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${bp.hue}, 70%, 70%, ${a * 0.15})`;
        ctx.fill();
      }

      const textProgress = Math.max(
        0,
        Math.min(1, (elapsed - PHASE.TEXT_START) / (PHASE.TEXT_DONE - PHASE.TEXT_START)),
      );

      if (textProgress > 0) {
        let textAlpha = easeOut(textProgress);
        if (elapsed > PHASE.HOLD_END) {
          const fadeT = (elapsed - PHASE.HOLD_END) / (PHASE.FADE_END - PHASE.HOLD_END);
          textAlpha *= 1 - fadeT;
        }

        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        const textY = cy + logoDisplaySize * 0.55;
        ctx.font = `300 ${22}px 'Inter', -apple-system, sans-serif`;
        ctx.letterSpacing = "8px";

        const chars = textStr.split("");
        const charWidth = 30;
        const totalWidth = chars.length * charWidth;
        const startX = cx - totalWidth / 2 + charWidth / 2;

        chars.forEach((char, i) => {
          const charProgress = Math.max(
            0,
            Math.min(1, (textProgress - i * 0.08) / 0.4),
          );
          const charEased = easeOut(charProgress);
          const charAlpha = charEased * textAlpha;
          const charY = textY + (1 - charEased) * 15;

          if (charAlpha <= 0) return;

          ctx.globalAlpha = charAlpha;
          ctx.fillStyle = "#7ab0c8";
          ctx.shadowColor = "rgba(100,180,220,0.5)";
          ctx.shadowBlur = 15;
          ctx.fillText(char, startX + i * charWidth, charY);
        });

        ctx.shadowBlur = 0;

        const subProgress = Math.max(0, textProgress - 0.5) * 2;
        if (subProgress > 0) {
          const subAlpha = easeOut(Math.min(1, subProgress)) * textAlpha * 0.35;
          ctx.globalAlpha = subAlpha;
          ctx.font = `300 ${10}px 'Inter', -apple-system, sans-serif`;
          ctx.letterSpacing = "4px";
          ctx.fillStyle = "#7ab0c8";
          ctx.fillText(subText, cx, textY + 28);
        }

        ctx.restore();
      }

      if (elapsed > PHASE.HOLD_END) {
        const fadeT = (elapsed - PHASE.HOLD_END) / (PHASE.FADE_END - PHASE.HOLD_END);
        ctx.fillStyle = `rgba(11, 14, 17, ${easeOut(fadeT)})`;
        ctx.fillRect(0, 0, W, H);
      }

      animId = requestAnimationFrame(render);
    }

    const img = new Image();
    img.onload = () => {
      logoImg = img;
      imgNaturalW = img.naturalWidth;
      imgNaturalH = img.naturalHeight;

      logoDisplaySize = Math.min(W, H) * 0.45;
      logoOffsetX = cx - logoDisplaySize / 2;
      logoOffsetY = cy - logoDisplaySize / 2;

      const points = sampleImagePoints(img, 700);
      points.forEach((pt, idx) => {
        const angle = Math.random() * Math.PI * 2;
        const dist = 300 + Math.random() * 400;
        const ox = cx + Math.cos(angle) * dist;
        const oy = cy + Math.sin(angle) * dist;
        const tx = logoOffsetX + (pt.x / imgNaturalW) * logoDisplaySize;
        const ty = logoOffsetY + (pt.y / imgNaturalH) * logoDisplaySize;
        logoParticles.push({
          targetX: tx,
          targetY: ty,
          x: ox,
          y: oy,
          originX: ox,
          originY: oy,
          size: pt.size,
          hue: 190 + Math.random() * 20,
          delay: (idx / points.length) * 0.3,
          arrived: false,
          trailX: [],
          trailY: [],
        });
      });

      animId = requestAnimationFrame(render);
    };
    img.src = appIcon;

    return () => cancelAnimationFrame(animId);
  }, [onDone]);

  return (
    <canvas
      ref={canvasRef}
      className="splash-screen"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
      }}
    />
  );
}
