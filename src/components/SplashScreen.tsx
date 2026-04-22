import { useEffect, useRef } from "react";

const PATHS = [
  "M 72 118 C 68 100, 62 78, 70 58 C 78 38, 100 22, 128 18",
  "M 68 126 C 62 110, 58 90, 68 72 C 78 54, 100 42, 136 38",
  "M 64 134 C 58 120, 56 102, 68 86 C 80 70, 106 58, 142 56",
  "M 60 140 C 56 128, 58 114, 72 100 C 86 86, 114 76, 148 74",
  "M 60 140 C 80 130, 110 108, 132 96 C 154 84, 170 78, 182 82",
  "M 60 140 C 74 142, 100 138, 126 128 C 152 118, 170 104, 180 90",
  "M 60 140 C 52 148, 40 158, 28 164 C 16 170, 10 168, 14 160",
  "M 60 140 C 50 152, 36 166, 22 176 C 8 186, 4 184, 10 174",
];

function samplePath(pathStr: string, count: number): { x: number; y: number }[] {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathStr);
  svg.appendChild(path);
  document.body.appendChild(svg);
  const len = path.getTotalLength();
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const pt = path.getPointAtLength((i / (count - 1)) * len);
    points.push({ x: pt.x, y: pt.y });
  }
  document.body.removeChild(svg);
  return points;
}

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

    const cx = W / 2;
    const cy = H / 2 - 20;
    const logoScale = Math.min(W, H) * 0.004;
    const logoOffsetX = cx - 100 * logoScale;
    const logoOffsetY = cy - 100 * logoScale;

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
    const particlesPerPath = 25;
    PATHS.forEach((pathStr, pathIdx) => {
      const pts = samplePath(pathStr, particlesPerPath);
      pts.forEach((pt, ptIdx) => {
        const angle = Math.random() * Math.PI * 2;
        const dist = 300 + Math.random() * 400;
        const ox = cx + Math.cos(angle) * dist;
        const oy = cy + Math.sin(angle) * dist;
        const tx = logoOffsetX + pt.x * logoScale;
        const ty = logoOffsetY + pt.y * logoScale;
        logoParticles.push({
          targetX: tx,
          targetY: ty,
          x: ox,
          y: oy,
          originX: ox,
          originY: oy,
          size: 1.2 + Math.random() * 1.8,
          hue: 190 + pathIdx * 5 + Math.random() * 10,
          delay: pathIdx * 0.06 + (ptIdx / particlesPerPath) * 0.04,
          arrived: false,
          trailX: [],
          trailY: [],
        });
      });
    });

    const burstParticles: BurstParticle[] = [];

    const textStr = "IBIS HUB";
    const subText = "MULTI-SESSION MANAGER";

    const start = performance.now();
    let animId = 0;

    const easeInOut = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

    function render(now: number) {
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
          0.5 +
          0.5 *
            Math.sin(
              elapsed * 0.001 * s.twinkleSpeed + s.twinkleOffset
            );
        const a = s.brightness * twinkle * starAlpha;
        if (elapsed > PHASE.HOLD_END) {
          const fadeProgress =
            (elapsed - PHASE.HOLD_END) / (PHASE.FADE_END - PHASE.HOLD_END);
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
        Math.min(
          1,
          (elapsed - PHASE.CONVERGE_START) /
            (PHASE.CONVERGE_END - PHASE.CONVERGE_START)
        )
      );

      logoParticles.forEach((p) => {
        const adjustedProgress = Math.max(
          0,
          Math.min(1, (convergeProgress - p.delay) / (1 - p.delay))
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
            Math.min(
              1,
              (elapsed - PHASE.CONVERGE_END) /
                (PHASE.GLOW_PEAK - PHASE.CONVERGE_END)
            )
          );
          alpha = 0.8 + glowT * 0.2;
        }

        if (elapsed > PHASE.HOLD_END) {
          const fadeT =
            (elapsed - PHASE.HOLD_END) / (PHASE.FADE_END - PHASE.HOLD_END);
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

      if (allArrived) {
        const glowT = Math.max(
          0,
          Math.min(
            1,
            (elapsed - PHASE.CONVERGE_END) /
              (PHASE.GLOW_PEAK - PHASE.CONVERGE_END)
          )
        );
        const glowEased = easeOut(glowT);

        let glowAlpha = glowEased * 0.25;
        if (elapsed > PHASE.HOLD_END) {
          const fadeT =
            (elapsed - PHASE.HOLD_END) / (PHASE.FADE_END - PHASE.HOLD_END);
          glowAlpha *= 1 - fadeT;
        }

        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 180 * logoScale);
        grad.addColorStop(0, `rgba(100, 180, 220, ${glowAlpha})`);
        grad.addColorStop(0.5, `rgba(100, 180, 220, ${glowAlpha * 0.3})`);
        grad.addColorStop(1, "transparent");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);

        const offscreen = document.createElement("canvas");
        offscreen.width = 200 * logoScale * dpr;
        offscreen.height = 200 * logoScale * dpr;
        const octx = offscreen.getContext("2d")!;
        octx.scale(dpr, dpr);
        octx.scale(logoScale, logoScale);
        octx.strokeStyle = `rgba(100, 180, 220, ${glowEased * 0.4})`;
        octx.lineWidth = 3;
        octx.lineCap = "round";
        octx.lineJoin = "round";

        PATHS.forEach((pathStr) => {
          const p2d = new Path2D(pathStr);
          octx.stroke(p2d);
        });

        let lineAlpha = glowEased * 0.4;
        if (elapsed > PHASE.HOLD_END) {
          const fadeT =
            (elapsed - PHASE.HOLD_END) / (PHASE.FADE_END - PHASE.HOLD_END);
          lineAlpha *= 1 - fadeT;
        }
        ctx.globalAlpha = lineAlpha > 0 ? lineAlpha / (glowEased * 0.4 || 1) : 0;
        ctx.drawImage(
          offscreen,
          logoOffsetX,
          logoOffsetY,
          200 * logoScale,
          200 * logoScale
        );
        ctx.globalAlpha = 1;
      }

      if (
        elapsed >= PHASE.BURST &&
        elapsed < PHASE.BURST + 200 &&
        burstParticles.length < 60
      ) {
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
          const fadeT =
            (elapsed - PHASE.HOLD_END) / (PHASE.FADE_END - PHASE.HOLD_END);
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
        Math.min(
          1,
          (elapsed - PHASE.TEXT_START) / (PHASE.TEXT_DONE - PHASE.TEXT_START)
        )
      );

      if (textProgress > 0) {
        let textAlpha = easeOut(textProgress);
        if (elapsed > PHASE.HOLD_END) {
          const fadeT =
            (elapsed - PHASE.HOLD_END) / (PHASE.FADE_END - PHASE.HOLD_END);
          textAlpha *= 1 - fadeT;
        }

        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        const textY = cy + 110 * logoScale;
        ctx.font = `300 ${22}px 'Inter', -apple-system, sans-serif`;
        ctx.letterSpacing = "8px";

        const chars = textStr.split("");
        const charWidth = 30;
        const totalWidth = chars.length * charWidth;
        const startX = cx - totalWidth / 2 + charWidth / 2;

        chars.forEach((char, i) => {
          const charProgress = Math.max(
            0,
            Math.min(1, (textProgress - i * 0.08) / 0.4)
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
        const fadeT =
          (elapsed - PHASE.HOLD_END) / (PHASE.FADE_END - PHASE.HOLD_END);
        ctx.fillStyle = `rgba(11, 14, 17, ${easeOut(fadeT)})`;
        ctx.fillRect(0, 0, W, H);
      }

      animId = requestAnimationFrame(render);
    }

    animId = requestAnimationFrame(render);

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
