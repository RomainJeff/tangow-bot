import {
  ACTIVE_RUN_STATUSES,
  avatarIdentitySeed,
  avatarShapeEyeOffset,
  avatarShapeFamily,
  organicAvatarPath,
} from "@rakazo/core";
import type { CSSProperties } from "react";
import { memo, useId } from "react";
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
  const reducedMotion = usePrefersReducedMotion();
  const seed = shapeSeed ?? avatarIdentitySeed(identity || color || "#8B5CF6");
  const duration = `${4.8 + (seed % 24) / 10}s`;
  const shapeA = organicAvatarPath(seed);
  const shapeB = organicAvatarPath(seed, 0.42);

  // The 2a grammar keeps one consistent eye rule; identity variation comes from
  // the 12 silhouettes and the hue, never a per-bot tilt.
  const luminance = relativeLuminance(color);
  const eyeFill = luminance < 0.4 ? "#FFFFFF" : "#101014";
  const needsInk = luminance > 0.78;
  const bodyStroke = needsInk ? "#17181A" : "none";
  const bodyStrokeWidth = needsInk ? 3.5 : 0;
  const eyeY = -10.5 + avatarShapeEyeOffset(seed);

  return (
    <svg
      viewBox="-60 -60 120 120"
      aria-hidden="true"
      className={cn("rakazo-organic-avatar overflow-visible select-none", className)}
      data-working={isWorking}
      data-shape-family={avatarShapeFamily(seed)}
      data-eye-pattern={seed % 4}
      style={{
        width: size,
        height: size,
        flex: "none",
      }}
    >
      {(["idle", "working"] as const).map((mode) => (
        <path
          key={mode}
          className={`rakazo-organic-avatar-body rakazo-organic-avatar-body-${mode}`}
          d={shapeA}
          fill={color}
          stroke={bodyStroke}
          strokeWidth={bodyStrokeWidth}
          style={
            {
              "--rakazo-organic-path": `path("${shapeA}")`,
              filter:
                mode === "working"
                  ? `drop-shadow(0 0 ${Math.round(size * 0.16)}px ${color})`
                  : "drop-shadow(0 2px 3px rgba(0,0,0,.34))",
            } as CSSProperties
          }
        >
          {!reducedMotion ? (
            <animate
              attributeName="d"
              values={`${shapeA};${shapeB};${shapeA}`}
              dur={duration}
              repeatCount="indefinite"
            />
          ) : null}
        </path>
      ))}
      {(["idle", "working"] as const).map((mode) => (
        <g
          key={mode}
          className={`rakazo-organic-avatar-eyes rakazo-organic-avatar-eyes-${mode}`}
          fill={eyeFill}
        >
          <rect x="-15" y={eyeY} width="7" height="21" rx="3.5" />
          <rect x="8" y={eyeY} width="7" height="21" rx="3.5" />
        </g>
      ))}
    </svg>
  );
}

/** WCAG relative luminance (0..1) of a hex colour. */
function relativeLuminance(hex: string): number {
  const clean = hex.replace(/^#/, "");
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const r = parseInt(expanded.slice(0, 2), 16);
  const g = parseInt(expanded.slice(2, 4), 16);
  const b = parseInt(expanded.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return 0.5;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
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
