import {
  ACTIVE_RUN_STATUSES,
  AVATAR_BODY_RADIUS,
  type AvatarPose,
  avatarIdentitySeed,
  organicAvatarFace,
  organicAvatarPath,
  REST_POSE,
  SWOOSH_COUNT,
  swooshPath,
  WORKING_STILL_SECONDS,
  workingPose,
} from "@rakazo/core";
import { type CSSProperties, memo, useEffect, useId, useRef, useSyncExternalStore } from "react";
import { type AvatarStyle, useAvatarStyle } from "./avatar-style.js";
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
  className?: string;
}

export const BotAvatar = memo(function BotAvatar({
  color,
  size = 38,
  status,
  variant,
  identity,
  shapeSeed,
  className,
}: BotAvatarProps) {
  const isWorking = ACTIVE_RUN_STATUSES.some((activeStatus) => activeStatus === status);
  const gradId = `spin-grad-${useId().replace(/[^a-zA-Z0-9-_]/g, "")}`;
  const preferredVariant = useAvatarStyle();
  if ((variant ?? preferredVariant) === "organic") {
    return (
      <OrganicAvatar
        color={color}
        identity={identity}
        shapeSeed={shapeSeed}
        size={size}
        isWorking={isWorking}
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

function OrganicAvatar({
  color,
  identity,
  shapeSeed,
  size,
  isWorking,
  className,
}: {
  color: string;
  identity?: string;
  shapeSeed?: number | null;
  size: number;
  isWorking: boolean;
  className?: string;
}) {
  const reducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    reducedMotionSnapshot,
    () => false,
  );
  const seed = shapeSeed ?? avatarIdentitySeed(identity || color || "#8B5CF6");
  const face = organicAvatarFace(seed);
  // Eyes are holes cut out of the body (bloub), so they live in a luminance mask.
  const maskId = `organic-eyes-${useId().replace(/[^a-zA-Z0-9-_]/g, "")}`;
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const R = AVATAR_BODY_RADIUS;
    const eyes = svg.querySelector<SVGElement>(".rakazo-organic-avatar-eyes")!;
    const eye = Array.from(svg.querySelectorAll<SVGElement>(".rakazo-organic-avatar-eye"));
    const arcs = Array.from(svg.querySelectorAll<SVGPathElement>(".rakazo-organic-avatar-swoosh"));
    const apply = (pose: AvatarPose) => {
      eyes.style.transform = `translate(${pose.eyes.x * R}px, ${pose.eyes.y * R}px) rotate(${pose.eyes.roll}deg)`;
      eye.forEach((el, i) => {
        const [sx, sy] = pose.eyes.scale[i]!;
        el.style.transform = `rotate(${pose.eyes.tilt[i]}deg) scale(${sx}, ${sy})`;
      });
      arcs.forEach((el, i) => {
        el.style.opacity = String(pose.swoosh.opacity);
        if (pose.swoosh.opacity > 0) el.setAttribute("d", swooshPath(i, pose.swoosh.t, R));
      });
    };
    if (!isWorking) {
      apply(REST_POSE);
      return;
    }
    if (reducedMotion) {
      apply(workingPose(WORKING_STILL_SECONDS));
      return;
    }
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      apply(workingPose((now - start) / 1000));
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [isWorking, reducedMotion]);

  return (
    <svg
      ref={svgRef}
      viewBox="-60 -60 120 120"
      aria-hidden="true"
      className={cn("rakazo-organic-avatar overflow-visible select-none", className)}
      data-working={isWorking}
      data-shape-family={seed % 10}
      data-eye-pattern={seed % 4}
      style={{
        width: size,
        height: size,
        flex: "none",
      }}
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="-60" y="-60" width="120" height="120">
          <rect x="-60" y="-60" width="120" height="120" fill="#fff" />
          <g transform={`translate(${face.x} ${face.y})`}>
            <g className="rakazo-organic-avatar-eyes" fill="#000">
              {face.eyes.map((eye) => (
                <g
                  key={eye.transform}
                  className="rakazo-organic-avatar-eye"
                  style={{ transformOrigin: `${eye.x}px ${eye.y}px` }}
                >
                  <path d={eye.d} transform={eye.transform} />
                </g>
              ))}
            </g>
          </g>
        </mask>
      </defs>
      {Array.from({ length: SWOOSH_COUNT }, (_, i) => (
        <path
          key={i}
          className="rakazo-organic-avatar-swoosh"
          fill="none"
          stroke={color}
          strokeWidth={0.05 * AVATAR_BODY_RADIUS}
          strokeLinecap="round"
          opacity="0"
        />
      ))}
      <path d={organicAvatarPath(seed)} fill={color} mask={`url(#${maskId})`} />
    </svg>
  );
}

const reducedMotionMedia = "(prefers-reduced-motion: reduce)";

function reducedMotionSnapshot(): boolean {
  return window.matchMedia(reducedMotionMedia).matches;
}

function subscribeToReducedMotion(onChange: () => void): () => void {
  const media = window.matchMedia(reducedMotionMedia);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
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
      <span className="font-[Aeonik,ui-sans-serif] text-[28px] tracking-tight text-foreground">
        Rakazo
      </span>
    </div>
  );
}
