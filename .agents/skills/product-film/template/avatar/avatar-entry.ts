// Browser bundle of the real Tangow avatar engine (packages/core) for product films: global TangowAvatar.
// Seek-safe: `frameAt(t)` rebuilds the engine and replays every scripted event up to t,
// so any frame can be rendered in any order with the same result.
import { avatarIdentitySeed } from "../../../../../packages/core/src/avatar-identity";
import { GLANCE_MORPH, nextWorkingGlance } from "../../../../../packages/core/src/avatar-motion";
import {
  avatarInk,
  BotEngine,
  EXPRESSION_BY_ID,
  mixHex,
  NOTIF_BLUE,
  RAYON,
  SHAPES,
} from "../../../../../packages/core/src/bloub/index";
import type { BotFrame } from "../../../../../packages/core/src/bloub/index";
import type { ExpressionId } from "../../../../../packages/core/src/bloub/expressions";
import type { Look } from "../../../../../packages/core/src/bloub/engine";

export type AvatarEvent =
  | { at: number; kind: "look"; look: Look | null; morph?: number }
  | { at: number; kind: "mood"; mood: ExpressionId | null };

/** Same mulberry32 the seeded glances use: deterministic `random()` for `nextWorkingGlance`. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The product's working choreography (`nextWorkingGlance` with its real ranges and moods),
 * drawn from a fixed seed between `from` and `to`.
 */
export function workingGlances(seed: number, from: number, to: number): AvatarEvent[] {
  const random = mulberry32(seed);
  const events: AvatarEvent[] = [];
  let at = from;
  while (at < to) {
    const glance = nextWorkingGlance(random);
    events.push({ at, kind: "look", look: glance.look, morph: GLANCE_MORPH });
    events.push({ at, kind: "mood", mood: glance.mood });
    at += glance.delay;
  }
  events.push({ at: to, kind: "look", look: null });
  events.push({ at: to, kind: "mood", mood: null });
  return events;
}

export function createAvatar(opts: { color: string; identity?: string; shapeSeed?: number; events?: AvatarEvent[] }) {
  const seed = opts.shapeSeed ?? avatarIdentitySeed(opts.identity || opts.color);
  const shape = SHAPES[seed % SHAPES.length]!;
  const events = [...(opts.events ?? [])].sort((a, b) => a.at - b.at);
  return {
    shape: shape.id,
    frameAt(t: number): BotFrame {
      const engine = new BotEngine(RAYON, "idle", shape.radii);
      // Settled into its shape from the start, like an avatar already on screen.
      engine.setShape(shape.radii, -BotEngine.SHAPE_MORPH);
      for (const event of events) {
        if (event.at > t) break;
        if (event.kind === "look") engine.setLook(event.look, event.at, event.morph);
        else engine.setExpression(event.mood ? (EXPRESSION_BY_ID.get(event.mood) ?? null) : null, event.at);
      }
      return engine.sample(t);
    },
  };
}

const NS = "http://www.w3.org/2000/svg";
const HALF_VIEWBOX = RAYON * 1.12;

/** Renders a frame into an <svg>, mirroring `BloubAvatar` in `@tangow/ui-web/bot-avatar.tsx`. */
export function drawAvatar(svg: SVGSVGElement, frame: BotFrame, color: string, uid: string) {
  const { paper, outline } = avatarInk(color);
  const VB = HALF_VIEWBOX;
  svg.setAttribute("viewBox", `${-VB} ${-VB} ${VB * 2} ${VB * 2}`);
  svg.style.overflow = "visible";
  const el = (tag: string, attrs: Record<string, string | number | undefined>) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined) node.setAttribute(k, String(v));
    return node;
  };
  const clipId = `${uid}-clip`;
  const defs = el("defs", {});
  const clip = el("clipPath", { id: clipId });
  clip.appendChild(el("path", { d: frame.bodyPath }));
  defs.appendChild(clip);
  for (const arc of frame.arcs) {
    const grad = el("linearGradient", {
      id: `${uid}-${arc.id}`,
      gradientUnits: "userSpaceOnUse",
      x1: arc.grad.x1,
      y1: arc.grad.y1,
      x2: arc.grad.x2,
      y2: arc.grad.y2,
    });
    arc.grad.stops.forEach((stop: string, i: number) =>
      grad.appendChild(el("stop", { offset: i / (arc.grad.stops.length - 1), "stop-color": stop })),
    );
    defs.appendChild(grad);
  }
  const arcs = (side: "back" | "front") => {
    const g = el("g", { fill: "none", "stroke-linecap": "round" });
    for (const arc of frame.arcs)
      g.appendChild(el("path", { d: arc[side], stroke: `url(#${uid}-${arc.id})`, "stroke-width": arc.width, opacity: arc.opacity }));
    return g;
  };
  const dots = () => {
    const g = el("g", {});
    for (const dot of frame.dots) {
      const fill = dot.color ?? (dot.depth === undefined ? color : mixHex(paper, color, dot.depth));
      g.appendChild(
        dot.d
          ? el("path", { d: dot.d, fill, opacity: dot.opacity, transform: `translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})` })
          : el("circle", { cx: dot.x, cy: dot.y, r: dot.r, fill, opacity: dot.opacity }),
      );
    }
    return g;
  };
  const body = el("g", { opacity: frame.bodyAlpha });
  body.appendChild(el("path", { d: frame.bodyPath, fill: color }));
  const eyes = el("g", { "clip-path": `url(#${clipId})`, fill: paper });
  for (const eye of frame.eyes) eyes.appendChild(el("path", { d: eye.d, transform: eye.matrix, opacity: eye.alpha }));
  if (frame.notch) eyes.appendChild(el("circle", { cx: frame.notch.x, cy: frame.notch.y, r: frame.notch.r }));
  body.appendChild(eyes);
  if (outline) body.appendChild(el("path", { d: frame.bodyPath, fill: "none", stroke: outline, "stroke-width": RAYON * 0.06 }));

  svg.replaceChildren(defs, arcs("back"));
  if (frame.dotsBehind) svg.appendChild(dots());
  svg.appendChild(body);
  if (!frame.dotsBehind) svg.appendChild(dots());
  if (frame.notif) svg.appendChild(el("circle", { cx: frame.notif.x, cy: frame.notif.y, r: frame.notif.r, fill: NOTIF_BLUE }));
  svg.appendChild(arcs("front"));
}

/** The working line's avatar buzz: `rk-buzz` (120 ms, alternate, ±1.5 px, ±2°) as a function of time. */
export function buzzAt(t: number) {
  const phase = (t / 0.12) % 2;
  const k = phase < 1 ? phase : 2 - phase;
  return { x: -1.5 + 3 * k, rot: -2 + 4 * k };
}
