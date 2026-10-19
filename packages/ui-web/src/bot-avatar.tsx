import {
  avatarIdentitySeed,
  avatarInk,
  BotEngine,
  type BotFrame,
  EXPRESSION_BY_ID,
  GLANCE_MORPH,
  isWorkingStatus,
  mixHex,
  NOTIF_BLUE,
  nextWorkingGlance,
  pointerGaze,
  pointerLook,
  RAYON,
  SHAPES,
} from "@rakazo/core";
import type { CSSProperties } from "react";
import { memo, useEffect, useId, useRef, useState } from "react";
import { type AvatarStyle, useAvatarStyle } from "./avatar-style.js";
import { usePrefersReducedMotion } from "./lib/reduced-motion.js";
import { cn } from "./lib/utils.js";
import "./styles.css";

export interface BotAvatarProps {
  color: string;
  size?: number;
  status?: string;
  variant?: AvatarStyle;
  identity?: string;
  /** Picked organic shape; falls back to a shape derived from `identity`. */
  shapeSeed?: number | null;
  /**
   * The organic avatar looks toward a fine pointer (a mouse) wherever it is on
   * the page, and back to rest when the pointer leaves the window. A working
   * bot keeps its own glances, reduced motion turns it off, the robot ignores it.
   */
  followPointer?: boolean;
  className?: string;
}

export const BotAvatar = memo(function BotAvatar({
  color,
  size = 38,
  status,
  variant,
  identity,
  shapeSeed,
  followPointer,
  className,
}: BotAvatarProps) {
  const isWorking = isWorkingStatus(status);
  const gradId = `spin-grad-${useId().replace(/[^a-zA-Z0-9-_]/g, "")}`;
  const preferredVariant = useAvatarStyle();
  if ((variant ?? preferredVariant) === "organic") {
    return (
      <BloubAvatar
        color={color}
        identity={identity}
        shapeSeed={shapeSeed}
        size={size}
        isWorking={isWorking}
        followPointer={followPointer}
        className={className}
      />
    );
  }
  const visorW = Math.round(size * 0.68);
  const visorH = Math.round(size * 0.44);
  const eyeW = Math.max(4, Math.round(size * 0.14));
  const eyeH = Math.max(7, Math.round(size * 0.22));
  const eyeRadius = Math.max(2, Math.round(eyeW * 0.5));
  const eyeGap = Math.max(3, Math.round(size * 0.1));

  const seed = hashString(color || "#8B5CF6");
  const eyeVariant = seed % 4;
  const idleDuration = (4.2 + ((seed * 7) % 28) / 10).toFixed(2);
  const idleDelay = (-(((seed * 13) % 45) / 10)).toFixed(2);
  const eyeGlow = `0 0 4px #FFFFFF, 0 0 8px #FFFFFF, 0 0 14px ${lightenColor(color, 20)}`;
  const idleEyeAnimation = {
    "--rakazo-eye-animation-name": `rakazo-eyes-idle-${eyeVariant}`,
    "--rakazo-eye-animation-duration": `${idleDuration}s`,
    "--rakazo-eye-animation-easing": "cubic-bezier(0.4, 0, 0.2, 1)",
    "--rakazo-eye-animation-delay": `${idleDelay}s`,
  } as CSSProperties;
  const workingEyeAnimation = {
    "--rakazo-eye-animation-name": "rakazo-eyes-working",
    "--rakazo-eye-animation-duration": "1.4s",
    "--rakazo-eye-animation-easing": "ease-in-out",
    "--rakazo-eye-animation-delay": "0s",
  } as CSSProperties;

  return (
    <div
      className={cn(
        "rakazo-bot-avatar group relative flex items-center justify-center rounded-full select-none",
        className,
      )}
      data-working={isWorking}
      style={{
        width: size,
        height: size,
        flex: "none",
        background: `radial-gradient(circle at 35% 26%, ${lightenColor(color, 35)}, ${color} 55%, ${darkenColor(color, 40)} 100%)`,
        boxShadow: isWorking
          ? `0 0 0 2px rgba(255,255,255,0.25), 0 0 ${Math.round(size * 0.45)}px ${color}, inset 0 1px 2px rgba(255,255,255,0.6)`
          : `0 2px ${Math.max(4, Math.round(size * 0.15))}px rgba(0,0,0,0.4), inset 0 1px 1.5px rgba(255,255,255,0.4)`,
      }}
    >
      <svg
        className="rakazo-bot-avatar-ring absolute pointer-events-none"
        style={{
          inset: -4,
          width: size + 8,
          height: size + 8,
          filter: `drop-shadow(0 0 6px ${color}) drop-shadow(0 0 10px #ffffff)`,
        }}
        viewBox="0 0 48 48"
        fill="none"
      >
        <circle
          cx="24"
          cy="24"
          r="22"
          stroke={`url(#${gradId})`}
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeDasharray="45 80"
        />
        <circle cx="43" cy="24" r="2.8" fill="#ffffff" />
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="60%" stopColor={color} stopOpacity="0.9" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>

      <div
        className="rakazo-bot-avatar-visor relative flex items-center justify-center overflow-hidden transition-transform duration-200 group-hover:scale-[1.04]"
        style={{
          width: visorW,
          height: visorH,
          borderRadius: Math.round(visorH * 0.52),
          background: "linear-gradient(180deg, #101014 0%, #030305 100%)",
          boxShadow: "inset 0 1.5px 3px rgba(0,0,0,0.95), 0 1px 1px rgba(255,255,255,0.18)",
          border: "1px solid rgba(255,255,255,0.14)",
        }}
      >
        <div
          className="absolute top-0 inset-x-0 h-[40%] pointer-events-none rounded-t-full"
          style={{
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.01) 100%)",
          }}
        />

        {(["idle", "working"] as const).map((mode) => (
          <div
            key={mode}
            className={`rakazo-bot-avatar-eyes rakazo-bot-avatar-eyes-${mode} absolute inset-0 z-10 flex items-center justify-center`}
            style={{
              gap: eyeGap,
              ...(mode === "idle" ? idleEyeAnimation : workingEyeAnimation),
            }}
          >
            {[0, 1].map((eye) => (
              <span
                key={eye}
                className="block bg-white"
                style={{
                  width: eyeW,
                  height: eyeH,
                  borderRadius: eyeRadius,
                  backgroundColor: "#FFFFFF",
                  boxShadow: eyeGlow,
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
});

/** Half of the viewBox side: the resting body radius plus room for the blink squash. */
const BLOUB_HALF_VIEWBOX = RAYON * 1.12;

/**
 * The organic avatar, drawn by the vendored bloub engine (`@rakazo/core/bloub`): a
 * morphing ink body with the eyes punched out as holes and idle blinks. While a run
 * is active the bot glances around and changes mood at random intervals.
 */
function BloubAvatar({
  color,
  identity,
  shapeSeed,
  size,
  isWorking,
  followPointer,
  className,
}: {
  color: string;
  identity?: string;
  shapeSeed?: number | null;
  size: number;
  isWorking: boolean;
  followPointer?: boolean;
  className?: string;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const seed = shapeSeed ?? avatarIdentitySeed(identity || color || "#8B5CF6");
  const shape = SHAPES[seed % SHAPES.length]!;
  const uid = useId().replace(/[^a-zA-Z0-9-_]/g, "");
  const [engine] = useState(() => new BotEngine(RAYON, "idle", shape.radii));
  const clock = useRef(0);
  const svgRef = useRef<SVGSVGElement>(null);
  const [frame, setFrame] = useState<BotFrame>(() => engine.sample(0));

  useEffect(() => {
    if (reducedMotion) {
      // One still frame, settled into the state: no morph, no loop.
      engine.reset("idle", clock.current);
      engine.setShape(shape.radii, clock.current - BotEngine.SHAPE_MORPH);
      setFrame(engine.sample(clock.current + 1));
      return;
    }
    engine.setShape(shape.radii, clock.current);
    if (!isWorking) {
      engine.setLook(null, clock.current);
      engine.setExpression(null, clock.current);
    }
    // A working bot glances around and changes mood at random intervals.
    let nextGlance = clock.current;
    // ponytail: one rAF loop per avatar; share a ticker if a long sidebar burns CPU.
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      // Clamp the step like upstream so a backgrounded tab resumes without a jump.
      clock.current += Math.min((now - last) / 1000, 0.064);
      last = now;
      if (isWorking && clock.current >= nextGlance) {
        const glance = nextWorkingGlance();
        engine.setLook(glance.look, clock.current, GLANCE_MORPH);
        engine.setExpression(EXPRESSION_BY_ID.get(glance.mood) ?? null, clock.current);
        nextGlance = clock.current + glance.delay;
      }
      setFrame(engine.sample(clock.current));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, shape, isWorking, reducedMotion]);

  useEffect(() => {
    if (!followPointer || isWorking || reducedMotion) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;
    const onMove = (event: PointerEvent) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect || event.pointerType === "touch") return;
      const look = pointerLook({ x: event.clientX, y: event.clientY }, rect);
      engine.setLook(pointerGaze(look), clock.current);
    };
    const onLeave = () => engine.setLook(null, clock.current);
    const root = document.documentElement;
    window.addEventListener("pointermove", onMove);
    root.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      engine.setLook(null, clock.current);
    };
  }, [engine, followPointer, isWorking, reducedMotion]);

  // Same eye rule as before: the eyes show the "paper" behind the ink, so pick it
  // from the body luminance, and ink a pale body's outline so it stays visible.
  const { paper, outline } = avatarInk(color);
  const VB = BLOUB_HALF_VIEWBOX;
  const clipId = `${uid}-clip`;
  const dots = (
    <g>
      {frame.dots.map((dot, index) => {
        const fill =
          dot.color ?? (dot.depth === undefined ? color : mixHex(paper, color, dot.depth));
        return dot.d ? (
          <path
            key={index}
            d={dot.d}
            fill={fill}
            opacity={dot.opacity}
            transform={`translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})`}
          />
        ) : (
          <circle key={index} cx={dot.x} cy={dot.y} r={dot.r} fill={fill} opacity={dot.opacity} />
        );
      })}
    </g>
  );
  const arcs = (side: "back" | "front") => (
    <g fill="none" strokeLinecap="round">
      {frame.arcs.map((arc) => (
        <path
          key={arc.id}
          d={arc[side]}
          stroke={`url(#${uid}-${arc.id})`}
          strokeWidth={arc.width}
          opacity={arc.opacity}
        />
      ))}
    </g>
  );

  return (
    <svg
      ref={svgRef}
      viewBox={`${-VB} ${-VB} ${VB * 2} ${VB * 2}`}
      aria-hidden="true"
      className={cn("rakazo-organic-avatar overflow-visible select-none", className)}
      data-working={isWorking}
      style={{
        width: size,
        height: size,
        flex: "none",
      }}
    >
      <defs>
        {/* The eyes are holes in the body, so the silhouette clips them. */}
        <clipPath id={clipId}>
          <path d={frame.bodyPath} />
        </clipPath>
        {frame.arcs.map((arc) => (
          <linearGradient
            key={arc.id}
            id={`${uid}-${arc.id}`}
            gradientUnits="userSpaceOnUse"
            x1={arc.grad.x1}
            y1={arc.grad.y1}
            x2={arc.grad.x2}
            y2={arc.grad.y2}
          >
            {arc.grad.stops.map((stop, index) => (
              <stop key={index} offset={index / (arc.grad.stops.length - 1)} stopColor={stop} />
            ))}
          </linearGradient>
        ))}
      </defs>
      {arcs("back")}
      {frame.dotsBehind ? dots : null}
      <g opacity={frame.bodyAlpha}>
        {/* Paint the eyes over the ink rather than punching them through to a paper
            backing: a backing under the whole body bleeds through the antialiased
            silhouette as a dark fringe. */}
        <path d={frame.bodyPath} fill={color} />
        <g clipPath={`url(#${clipId})`} fill={paper}>
          {frame.eyes.map((eye, index) => (
            <path key={index} d={eye.d} transform={eye.matrix} opacity={eye.alpha} />
          ))}
          {frame.notch ? <circle cx={frame.notch.x} cy={frame.notch.y} r={frame.notch.r} /> : null}
        </g>
        {outline ? (
          <path d={frame.bodyPath} fill="none" stroke={outline} strokeWidth={RAYON * 0.06} />
        ) : null}
      </g>
      {frame.dotsBehind ? null : dots}
      {frame.notif ? (
        <circle cx={frame.notif.x} cy={frame.notif.y} r={frame.notif.r} fill={NOTIF_BLUE} />
      ) : null}
      {arcs("front")}
    </svg>
  );
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function lightenColor(hex: string, percent: number): string {
  return adjustColor(hex, percent);
}

function darkenColor(hex: string, percent: number): string {
  return adjustColor(hex, -percent);
}

function adjustColor(hex: string, percent: number): string {
  const clean = hex.replace(/^#/, "");
  if (clean.length !== 6 && clean.length !== 3) return hex;
  const num = parseInt(
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean,
    16,
  );
  if (Number.isNaN(num)) return hex;
  let r = (num >> 16) + Math.round((255 * percent) / 100);
  let g = ((num >> 8) & 0x00ff) + Math.round((255 * percent) / 100);
  let b = (num & 0x0000ff) + Math.round((255 * percent) / 100);
  r = Math.min(255, Math.max(0, r));
  g = Math.min(255, Math.max(0, g));
  b = Math.min(255, Math.max(0, b));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="flex h-11 w-11 items-center justify-center gap-1.5 rounded-full bg-card">
        <span className="h-4 w-[7px] rounded-full bg-primary" />
        <span className="h-4 w-[7px] rounded-full bg-primary" />
      </div>
      <span className="font-sans text-[28px] tracking-tight text-foreground">Rakazo</span>
    </div>
  );
}
