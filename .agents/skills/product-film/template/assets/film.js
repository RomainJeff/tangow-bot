// YOUR FILM. The engine does the rest; this file holds the screens, the UI beats and the shots.
// Example: 14.5 s, two screens (light, dark), four shots alternating object and UI, two benefit lines, the end card.
// Times are seconds of the master timeline. Once the music is chosen, move every cut onto a beat (scripts/beats.py).
import { runEngine, LENS, UI_FILL } from "./engine.js";

const K = window.ScreenKit;

// ---- Screens (402 × 874). Everything the timeline animates carries a data-part.
const home = K.screen({
  theme: "light", time: "9:00", title: "Assistant", id: "scr-home",
  thread: `<div class="day" style="font-size:13px;line-height:18px">Today 9:00</div>
    <div data-part="msg" style="display:flex;flex-direction:column;gap:12px;height:0;overflow:hidden;opacity:0">
      ${K.ln("repeat", "Morning brief")}
      ${K.bb("Three things moved overnight. All handled, one needs your call.")}
    </div>
    ${K.wl(["Checking your calendar"], "height:26px")}`,
});
const night = K.screen({
  theme: "dark", time: "21:30", title: "Assistant", id: "scr-night",
  thread: `${K.ub("Remind me before the train tomorrow.")}
    <div data-part="reply" style="height:0;overflow:hidden;opacity:0">${K.bb("Done. I’ll nudge you at 7:40.")}</div>`,
});

const T_NIGHT = 8.6, T_CARD = 10.9;
const part = (scr, n) => [...scr.querySelectorAll("[data-part]")].find((e) => e.dataset.part === n);
// The bot's mark in the working line: a plain dot here; draw your product's avatar instead.
part(home, "wl-av").innerHTML = '<circle cx="13" cy="13" r="12" fill="#1d1d1f" />';

runEngine({
  W: 1920, H: 1080, duration: 14.5,
  screens: { home, night },
  screenAt: (t) => (t < T_NIGHT ? "home" : "night"),
  // Per-frame DOM: the working line's counter starts near zero (a long "thinking" time doesn't sell).
  drawUI: (t) => { part(home, "wl-time").textContent = `${Math.max(0, t - 2.4).toFixed(1)}s`; },
  build({ tl, cam, scr, measure, show, positions, cut, benefit, endCard, drift }) {
    // ===== UI beats (DOM) =====
    show("home");
    const msg = part(home, "msg"), wl = part(home, "wl"), msgH = measure(msg);
    show("night");
    const reply = part(night, "reply"), replyH = measure(reply);
    tl.to(wl, { height: 0, opacity: 0, duration: 0.4, ease: "power3.inOut" }, 4.2);
    tl.to(msg, { height: msgH, opacity: 1, duration: 0.55, ease: "power3.out" }, 4.25);
    tl.to(reply, { height: replyH, opacity: 1, duration: 0.5, ease: "power3.out" }, 9.4);

    // ===== Where things sit on the glass (measured on the live layout, after the beats) =====
    const Y = positions({ wl: [3.0, wl], msg: [5.2, msg] });

    // ===== Shots =====
    // S1 · 0–2.4 · OBJECT · the phone alone, screen asleep, fade up by exposure; the title in the empty side.
    tl.set(scr, { bright: 0 }, 0);
    cut(0, { yaw: 40, elev: -8, dist: 82, tx: -6.2, ty: 0, fov: LENS[85], fstop: 2.8, expo: 0, ui: 0 });
    tl.to(cam, { expo: 1, duration: 0.6, ease: drift }, 0);
    tl.to(cam, { yaw: 34, elev: -9, dist: 76, duration: 2.4, ease: drift }, 0);
    tl.fromTo("#super", { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.35, ease: "land" }, 0.5);
    tl.to("#super", { opacity: 0, duration: 0.2, ease: "none" }, 2.1);

    // S2 · CUT 2.4 · UI · the screen wakes, the bot is working, then its message lands; a slow push.
    cut(2.4, { yaw: 6, elev: 0, dist: UI_FILL + 2, tx: 0, ty: Y.wl, fx: 0, fy: Y.wl, fov: LENS[100], fstop: 5.6, ui: 1 });
    tl.to(scr, { bright: 1.05, duration: 0.3, ease: "power1.out" }, 2.45);
    tl.to(cam, { dist: UI_FILL, duration: 3.6, ease: drift }, 2.4);
    tl.to(cam, { ty: Y.msg, fy: Y.msg, duration: 0.8, ease: "land" }, 4.25);

    // S3 · CUT 6.0 · OBJECT close · the phone left, a benefit line on the right.
    cut(6.0, { yaw: -30, elev: -8, dist: 44, tx: 3.2, ty: Y.msg, fx: 0, fy: Y.msg, fov: LENS[85], fstop: 2.8, ui: 0 });
    tl.to(cam, { yaw: -24, dist: 40, duration: 2.6, ease: "travel" }, 6.0);
    benefit("b1", 6.4, 8.4);

    // S4 · CUT 8.6 · OBJECT · night, dark mode: only the screen changed; the reply arrives; the second line.
    cut(T_NIGHT, { yaw: 32, elev: -10, dist: 78, tx: 5.6, ty: 0, fx: 0, fy: 0, fov: LENS[85], fstop: 2.8, ui: 0 });
    tl.to(cam, { yaw: 28, dist: 72, duration: 2.3, ease: drift }, T_NIGHT);
    benefit("b2", 8.9, 10.7);

    // 10.9 · CUT to the end card.
    endCard(T_CARD);
  },
});

