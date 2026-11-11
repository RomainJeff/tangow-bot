import type { AvatarStyle } from "@tangow/contracts";
import type { BotFrame, ExpressionId, Look } from "@tangow/core";
import {
  avatarIdentitySeed,
  avatarInk,
  BotEngine,
  EXPRESSION_BY_ID,
  GLANCE_MORPH,
  isWorkingStatus,
  mixHex,
  nextWorkingGlance,
  RAYON,
  SHAPES,
} from "@tangow/core";
import { memo, useEffect, useId, useRef, useState } from "react";
import { View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import Svg, { ClipPath, Defs, G, Path, Use } from "react-native-svg";
import { CHAT_MOTION } from "../lib/chat-motion";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { useAvatarStyle } from "./avatar-style";
import { NativeSymbol } from "./native-symbol";

/** A one-shot look, right after mount only (7f) — see `OrganicAvatar`. */
export type BotAvatarGlance = "left" | "right";

export const BotAvatar = memo(function BotAvatar({
  color,
  size = 54,
  status,
  identity,
  shapeSeed,
  variant,
  muted = false,
  glance,
  still = false,
}: {
  color: string;
  size?: number;
  status?: string;
  identity?: string;
  /** Picked organic shape; falls back to a shape derived from `identity`. */
  shapeSeed?: number | null;
  variant?: AvatarStyle;
  muted?: boolean;
  /**
   * A new "Messaged / Message from" marker (7f): this avatar glances once
   * toward its peer, then back to centre. Read only at mount — the caller
   * passes it exclusively for a marker the arrivals helper just flagged as
   * new, never for one already on screen at thread open. Organic variant
   * only; the robot avatar ignores it.
   */
  glance?: BotAvatarGlance;
  /** Rests on one drawn frame instead of breathing and blinking, and moves
   * only while the bot works or glances. For avatars repeated down a thread,
   * where a loop each would redraw every frame and stall scrolling. */
  still?: boolean;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const isWorking = isWorkingStatus(status);
  const { avatarStyle } = useAvatarStyle();
  const visorW = Math.round(size * 0.68);
  const visorH = Math.round(size * 0.44);
  const eyeW = Math.max(3, Math.round(size * 0.11));
  const eyeH = Math.max(4, Math.round(size * 0.17));
  const gap = Math.max(3, Math.round(size * 0.11));
  return (
    <View style={{ width: size, height: size }}>
      {(variant ?? avatarStyle) === "organic" ? (
        <OrganicAvatar
          color={color}
          identity={identity}
          shapeSeed={shapeSeed}
          size={size}
          isWorking={isWorking}
          glance={glance}
          still={still}
        />
      ) : (
        <View
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View
            style={{
              width: visorW,
              height: visorH,
              borderRadius: Math.round(visorH * 0.52),
              backgroundColor: "#0C0C0E",
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap,
            }}
          >
            {[0, 1].map((eye) => (
              <View
                key={eye}
                style={{
                  width: eyeW,
                  height: eyeH,
                  borderRadius: Math.max(2, Math.round(eyeW * 0.6)),
                  backgroundColor: "#fff",
                }}
              />
            ))}
          </View>
        </View>
      )}
      {isWorking ? (
        <View
          accessibilityLabel={t("Working")}
          style={{
            position: "absolute",
            right: muted ? undefined : 0,
            left: muted ? 0 : undefined,
            bottom: 0,
            width: Math.max(6, Math.round(size * 0.18)),
            height: Math.max(6, Math.round(size * 0.18)),
            borderRadius: size,
            backgroundColor: "#F5A03C",
          }}
        />
      ) : null}
      {muted ? (
        <View
          accessible
          accessibilityLabel={t("Notifications silenced")}
          style={{
            position: "absolute",
            right: -2,
            bottom: -2,
            width: Math.max(14, Math.round(size * 0.34)),
            height: Math.max(14, Math.round(size * 0.34)),
            borderRadius: size,
            borderWidth: 2,
            borderColor: "#000",
            backgroundColor: "#242428",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <NativeSymbol
            ios="bell.slash.fill"
            android="notifications-off"
            size={Math.max(8, Math.round(size * 0.17))}
            color={tokens.foreground}
          />
        </View>
      ) : null}
    </View>
  );
});

/** Half of the viewBox side: the resting body radius plus room for the blink squash. */
const BLOUB_HALF_VIEWBOX = RAYON * 1.12;

/** An explicit mood + look, overriding the idle/working choreography (e.g. the launch splash). */
export interface OrganicAvatarDrive {
  mood: ExpressionId;
  look: Look | null;
}

/**
 * The organic avatar, drawn by the bloub engine (`@tangow/core/bloub`) like web and
 * desktop: a morphing ink body with the eyes punched out and idle blinks. While a
 * run is active the bot glances around and changes mood at random intervals.
 *
 * `drive`, when set, takes over the mood/look instead: the launch splash uses it to
 * step through the wake-up choreography. Existing callers never pass it, so idle and
 * working behave exactly as before.
 */
export function OrganicAvatar({
  color,
  identity,
  shapeSeed,
  size,
  isWorking,
  glance,
  drive,
  still = false,
}: {
  color: string;
  identity?: string;
  shapeSeed?: number | null;
  size: number;
  isWorking: boolean;
  glance?: BotAvatarGlance;
  drive?: OrganicAvatarDrive | null;
  /** See `BotAvatar`'s `still`. */
  still?: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const [glancing, setGlancing] = useState(Boolean(glance) && !reducedMotion);
  const animate = !still || isWorking || Boolean(drive) || glancing;
  const seed = shapeSeed ?? avatarIdentitySeed(identity || color || "#8B5CF6");
  const shape = SHAPES[seed % SHAPES.length]!;
  const id = useId().replace(/[^a-zA-Z0-9-_]/g, "");
  const bodyId = `bloub-body-${id}`;
  const clipId = `bloub-${id}`;
  const [engine] = useState(() => new BotEngine(RAYON, "idle", shape.radii));
  const clock = useRef(0);
  const [frame, setFrame] = useState<BotFrame>(() => engine.sample(0));
  // Colour crossfade: the engine only morphs shape, so the fill's own interpolation
  // lives here, on the same timeline as `clock` and the same duration as a shape morph.
  const colorMorph = useRef({ from: color, to: color, at: 0 });
  const renderedColor = useRef(color);
  const [fill, setFill] = useState(color);

  useEffect(() => {
    if (reducedMotion || !animate) {
      // No crossfade under reduced motion or at rest: snap straight to the new colour.
      colorMorph.current = { from: color, to: color, at: clock.current };
      renderedColor.current = color;
      setFill(color);
      return;
    }
    if (colorMorph.current.to === color) return;
    colorMorph.current = { from: renderedColor.current, to: color, at: clock.current };
  }, [color, reducedMotion, animate]);

  // 7f: a one-shot glance toward the peer bloub, read once at mount only —
  // `glance` is a mount-time direction (the caller only ever sets it for a
  // marker the arrivals helper just flagged as new), not a live prop to
  // re-trigger on. Skipped entirely under reduced motion (MA-10: nothing, no
  // fade substitute, for the avatar look).
  useEffect(() => {
    if (!glance || reducedMotion) return;
    const yaw = glance === "right" ? CHAT_MOTION.glanceYawDeg : -CHAT_MOTION.glanceYawDeg;
    engine.setLook({ yaw, pitch: 0, mix: 1, spin: 0, wander: 0 }, clock.current);
    const timer = setTimeout(() => {
      engine.setLook(null, clock.current);
    }, CHAT_MOTION.glanceHoldMs);
    // A still avatar keeps its loop only until the look has eased back.
    const settle = setTimeout(
      () => setGlancing(false),
      CHAT_MOTION.glanceHoldMs + CHAT_MOTION.glanceSettleMs,
    );
    return () => {
      clearTimeout(timer);
      clearTimeout(settle);
    };
  }, []);

  useEffect(() => {
    if (reducedMotion || !animate) {
      // One still frame, settled into the state: no morph, no loop.
      engine.reset("idle", clock.current);
      engine.setShape(shape.radii, clock.current - BotEngine.SHAPE_MORPH);
      setFrame(engine.sample(clock.current + 1));
      colorMorph.current = { from: color, to: color, at: clock.current };
      renderedColor.current = color;
      setFill(color);
      return;
    }
    engine.setShape(shape.radii, clock.current);
    if (drive) {
      engine.setExpression(EXPRESSION_BY_ID.get(drive.mood) ?? null, clock.current);
      engine.setLook(drive.look, clock.current, GLANCE_MORPH);
    } else if (!isWorking) {
      engine.setLook(null, clock.current);
      engine.setExpression(null, clock.current);
    }
    let nextGlance = clock.current;
    // ponytail: one rAF loop per avatar, like web; share a ticker if a long inbox burns CPU.
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      // Clamp the step like web so a backgrounded app resumes without a jump.
      if (last) clock.current += Math.min((now - last) / 1000, 0.064);
      last = now;
      if (!drive && isWorking && clock.current >= nextGlance) {
        const glance = nextWorkingGlance();
        engine.setLook(glance.look, clock.current, GLANCE_MORPH);
        engine.setExpression(EXPRESSION_BY_ID.get(glance.mood) ?? null, clock.current);
        nextGlance = clock.current + glance.delay;
      }
      setFrame(engine.sample(clock.current));
      const { from, to, at } = colorMorph.current;
      const k = Math.min(Math.max((clock.current - at) / BotEngine.SHAPE_MORPH, 0), 1);
      const next = k >= 1 ? to : mixHex(from, to, k);
      renderedColor.current = next;
      setFill(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, shape, isWorking, reducedMotion, drive, animate]);

  // Same eye rule as web: the eyes show the "paper" behind the ink, so pick it from
  // the body luminance, and ink a pale body's outline so it stays visible.
  const { paper, outline } = avatarInk(fill);
  const VB = BLOUB_HALF_VIEWBOX;

  return (
    <Svg width={size} height={size} viewBox={`${-VB} ${-VB} ${VB * 2} ${VB * 2}`}>
      <Defs>
        {/* Drawn through `Use` below, so native parses the body path once per frame. */}
        <Path id={bodyId} d={frame.bodyPath} />
        {/* The eyes are holes in the body, so the silhouette clips them. */}
        <ClipPath id={clipId}>
          <Use href={`#${bodyId}`} />
        </ClipPath>
      </Defs>
      {/* ponytail: body and eyes only — the idle state the avatar stays in never
          emits the engine's particles, arcs or notification dot. */}
      <G opacity={frame.bodyAlpha}>
        <Use href={`#${bodyId}`} fill={fill} />
        <G clipPath={`url(#${clipId})`}>
          {frame.eyes.map((eye, index) => (
            <Path key={index} d={eye.d} transform={eye.matrix} opacity={eye.alpha} fill={paper} />
          ))}
        </G>
        {outline ? (
          <Use href={`#${bodyId}`} fill="none" stroke={outline} strokeWidth={RAYON * 0.06} />
        ) : null}
      </G>
    </Svg>
  );
}
