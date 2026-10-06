/**
 * Reconnect machine for the chrome-less noVNC embed. Pure: the session feeds events stamped
 * with `now`, runs the returned effects, and calls `step` again with `tick` at `nextWake`.
 * The wire constants mirror `@rakazo/core`'s screen-link contract; a drift test in core
 * equates them, because this file ships alone in the computer image.
 */

export const SCREEN_STATES = ["connecting", "connected", "reconnecting", "stalled", "failed"];
export const MESSAGE_TYPE = "rakazo-screen-state";
export const MESSAGE_VERSION = 1;

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const JITTER = 0.25;
const BUDGET_MS = 60_000;
const STABLE_MS = 10_000;
const ATTEMPT_TIMEOUT_MS = 10_000;
const FIRST_FRAME_GRACE_MS = 2_000;
const NUDGE_FLOOR_MS = 5_000;
const RECYCLE_HIDDEN_MS = 10_000;
const HEARTBEAT_MS = 1_000;
const CLOCK_GAP_MS = 5_000;
const STALLED_AT_FAILURES = 2;

export function encodeStateMessage(state) {
  return JSON.stringify({ type: MESSAGE_TYPE, version: MESSAGE_VERSION, state });
}

export function initialModel() {
  return {
    phase: { name: "idle" },
    painted: false,
    frozen: false,
    announced: null,
    outageStart: 0,
    failures: 0,
    stalled: false,
    attemptedAt: null,
    hiddenAt: null,
    online: true,
    lastAt: 0,
  };
}

export function step(model, event, env) {
  const phase = model.phase.name;
  if (phase === "stopped" || (phase === "idle" && event.type !== "start")) {
    return { model, effects: [] };
  }
  const m = { ...model };
  const fx = [];
  const now = event.now;
  switch (event.type) {
    case "start":
      if (phase !== "idle") break;
      m.online = event.online;
      m.hiddenAt = event.visible ? null : now;
      m.outageStart = now;
      announce(m, fx, "connecting");
      waitUntil(m, fx, now, now);
      break;
    case "connect":
      if (phase === "opening") m.phase = { name: "painting", since: now };
      break;
    case "painted":
      if (phase === "painting") goLive(m, fx, model.phase.since);
      break;
    case "drop":
      drop(m, fx, now, env);
      break;
    case "tick":
      tick(m, fx, now, env, model.lastAt);
      break;
    case "hidden":
      m.hiddenAt ??= now;
      break;
    case "visible": {
      if (m.hiddenAt === null) break;
      const hiddenFor = now - m.hiddenAt;
      m.hiddenAt = null;
      if (hiddenFor >= RECYCLE_HIDDEN_MS) recycle(m, fx, now);
      else nudge(m, fx, now);
      break;
    }
    case "online":
      m.online = true;
      nudge(m, fx, now);
      break;
    case "offline":
      m.online = false;
      break;
  }
  m.lastAt = now;
  return { model: m, effects: fx };
}

export function nextWake(model) {
  const phase = model.phase;
  if (model.hiddenAt !== null) return null;
  const budgetEnd = model.outageStart + BUDGET_MS;
  switch (phase.name) {
    case "opening":
      return Math.min(phase.since + ATTEMPT_TIMEOUT_MS, budgetEnd);
    case "painting":
      return phase.since + FIRST_FRAME_GRACE_MS;
    case "live":
      return model.lastAt + HEARTBEAT_MS;
    case "waiting":
      return model.online ? Math.min(phase.until, budgetEnd) : budgetEnd;
    default:
      return null;
  }
}

function drop(m, fx, now, env) {
  const phase = m.phase;
  if (phase.name !== "opening" && phase.name !== "painting" && phase.name !== "live") return;
  if (phase.name === "live") freeze(m, fx);
  if (phase.name !== "opening" && now - phase.since >= STABLE_MS) {
    openOutage(m, now);
    announce(m, fx, m.painted ? "reconnecting" : "connecting");
    waitUntil(m, fx, now, now);
    return;
  }
  fail(m, fx, now, env);
}

function tick(m, fx, now, env, lastAt) {
  const phase = m.phase;
  if (m.hiddenAt !== null) return;
  if (phase.name === "live") {
    if (now - lastAt > CLOCK_GAP_MS) recycle(m, fx, now);
    return;
  }
  if (phase.name === "painting") {
    if (now - phase.since >= FIRST_FRAME_GRACE_MS) goLive(m, fx, phase.since);
    return;
  }
  if (now - m.outageStart >= BUDGET_MS) {
    stop(m, fx);
    return;
  }
  if (phase.name === "opening" && now - phase.since >= ATTEMPT_TIMEOUT_MS) {
    fx.push({ type: "abort" });
    fail(m, fx, now, env);
    return;
  }
  if (phase.name === "waiting" && phase.until <= now) waitUntil(m, fx, now, phase.until);
}

/** A page that was away long enough may hold a half-open socket: start over on a fresh budget. */
function recycle(m, fx, now) {
  const name = m.phase.name;
  if (name === "live") freeze(m, fx);
  if (name === "opening" || name === "painting" || name === "live") fx.push({ type: "abort" });
  openOutage(m, now);
  announce(m, fx, m.painted ? "reconnecting" : "connecting", true);
  waitUntil(m, fx, now, earliestNudge(m, now));
}

function nudge(m, fx, now) {
  if (m.phase.name !== "waiting") return;
  waitUntil(m, fx, now, Math.min(m.phase.until, earliestNudge(m, now)));
}

function fail(m, fx, now, env) {
  m.failures += 1;
  if (m.hiddenAt === null && now - m.outageStart >= BUDGET_MS) {
    stop(m, fx);
    return;
  }
  announce(m, fx, m.painted ? "reconnecting" : "connecting");
  if (m.failures >= STALLED_AT_FAILURES && !m.stalled) {
    m.stalled = true;
    fx.push({ type: "emit", state: "stalled" });
  }
  waitUntil(m, fx, now, now + backoff(m.failures, env.rand));
}

function waitUntil(m, fx, now, until) {
  m.phase = { name: "waiting", until };
  if (until > now || m.hiddenAt !== null || !m.online) return;
  m.phase = { name: "opening", since: now };
  m.attemptedAt = now;
  fx.push({ type: "attempt" });
}

function goLive(m, fx, since) {
  m.phase = { name: "live", since };
  m.painted = true;
  if (m.frozen) {
    m.frozen = false;
    fx.push({ type: "thaw" });
  }
  announce(m, fx, "connected");
}

function stop(m, fx) {
  m.phase = { name: "stopped" };
  m.frozen = false;
  m.announced = "failed";
  fx.push({ type: "stop" }, { type: "emit", state: "failed" });
}

function freeze(m, fx) {
  m.frozen = true;
  fx.push({ type: "freeze" });
}

function openOutage(m, now) {
  m.outageStart = now;
  m.failures = 0;
  m.stalled = false;
}

function announce(m, fx, state, fresh = false) {
  if (!fresh && m.announced === state) return;
  m.announced = state;
  fx.push({ type: "emit", state });
}

function earliestNudge(m, now) {
  return m.attemptedAt === null ? now : Math.max(now, m.attemptedAt + NUDGE_FLOOR_MS);
}

function backoff(failures, rand) {
  const base = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1];
  return Math.round(base * (1 + JITTER * (2 * rand() - 1)));
}
