import { useEffect, useState } from "react";
import logoUrl from "../assets/logo.png";

const FADE_IN = 0.6;
const GLOW_SWEEP = 0.8;
const TEXT_IN = 0.4;
const HOLD = 0.8;
const FADE_OUT = 0.5;
const TOTAL = FADE_IN + GLOW_SWEEP + TEXT_IN + HOLD + FADE_OUT;

type Phase = "logo-in" | "glow" | "text-in" | "hold" | "fade" | "done";

const TIMINGS: [Phase, number][] = [
  ["logo-in", 0],
  ["glow", FADE_IN * 1000],
  ["text-in", (FADE_IN + GLOW_SWEEP) * 1000],
  ["hold", (FADE_IN + GLOW_SWEEP + TEXT_IN) * 1000],
  ["fade", (TOTAL - FADE_OUT) * 1000],
  ["done", TOTAL * 1000],
];

export default function SplashScreen({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>("logo-in");

  useEffect(() => {
    const timers = TIMINGS.map(([p, ms]) =>
      setTimeout(() => {
        setPhase(p);
        if (p === "done") onDone();
      }, ms)
    );
    return () => timers.forEach(clearTimeout);
  }, [onDone]);

  if (phase === "done") return null;

  const logoVisible = phase !== "logo-in";
  const glowActive = phase === "glow" || phase === "text-in" || phase === "hold";
  const textVisible = phase === "text-in" || phase === "hold" || phase === "fade";
  const fading = phase === "fade";

  return (
    <div
      className="splash-screen"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#0b0e11",
        opacity: fading ? 0 : 1,
        transition: `opacity ${FADE_OUT}s ease-out`,
      }}
    >
      {/* Logo container */}
      <div
        style={{
          position: "relative",
          width: 140,
          height: 140,
        }}
      >
        {/* Glow sweep overlay */}
        <div
          style={{
            position: "absolute",
            inset: -20,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(100,180,220,0.15) 0%, transparent 70%)",
            opacity: glowActive ? 1 : 0,
            transform: glowActive ? "scale(1.2)" : "scale(0.8)",
            transition: "opacity 0.6s ease, transform 0.8s ease",
          }}
        />

        {/* Shine sweep across logo */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            overflow: "hidden",
            borderRadius: 8,
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 0,
              left: glowActive ? "120%" : "-60%",
              width: "50%",
              height: "100%",
              background: "linear-gradient(90deg, transparent, rgba(150,210,240,0.3), transparent)",
              transform: "skewX(-20deg)",
              transition: `left ${GLOW_SWEEP}s ease-in-out`,
            }}
          />
        </div>

        {/* Logo image */}
        <img
          src={logoUrl}
          alt="Ibis Hub"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            filter: "invert(1) brightness(1.8) drop-shadow(0 0 20px rgba(100,180,220,0.3))",
            opacity: logoVisible ? 1 : 0,
            transform: logoVisible ? "scale(1)" : "scale(0.85)",
            transition: `opacity ${FADE_IN}s ease-out, transform ${FADE_IN}s ease-out`,
          }}
        />
      </div>

      {/* App name */}
      <span
        style={{
          marginTop: 28,
          fontSize: 20,
          fontWeight: 300,
          letterSpacing: "0.2em",
          color: "#7ab0c8",
          opacity: textVisible ? 1 : 0,
          transform: textVisible ? "translateY(0)" : "translateY(12px)",
          transition: `opacity ${TEXT_IN}s ease, transform ${TEXT_IN}s ease`,
        }}
      >
        IBIS HUB
      </span>
    </div>
  );
}
