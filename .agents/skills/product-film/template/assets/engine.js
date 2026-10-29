// The product-film engine: one studio, one phone, HTML screens playing live on its glass, one camera rig.
// A film (film.js) hands it its screens and a build(api) that writes the timeline; the engine owns capture,
// camera, light, benefit lines, the end card and the cutdowns. Units: centimetres, phone-local frame
// (origin at the screen centre, +X right, +Y up, +Z out of the screen).
import * as THREE from "three";
import { createWorld, SCREEN_H } from "./world.js";

// Lenses as vertical FOV (deg) for a 16:9 frame: 100 / 85 / 65 mm equivalents.
export const LENS = { 100: 11.6, 85: 13.6, 65: 17.7 };
// UI fill: the screen's width at 92% of the frame width at 100 mm, so the glass edge and bezel always peek in.
export const UI_FILL = 20.5, UI_TIGHT = 17.9;
export const FRAME_H = (d, fov) => 2 * d * Math.tan(THREE.MathUtils.degToRad(fov / 2));
// A point on the 402 × 874 pt screen, as phone-local cm (y up from the screen centre).
export const screenY = (pt) => ((874 / 2 - pt) / 874) * SCREEN_H;

/**
 * @param {object} o
 * @param {number} o.duration seconds of the master timeline
 * @param {Record<string, HTMLElement>} o.screens the film's screens (402 × 874), by name
 * @param {(t: number) => string} o.screenAt which screen is on the glass at t
 * @param {(t: number) => void} [o.drawUI] per-frame DOM updates (counters, avatars)
 * @param {string[]} [o.preload] images to decode before the first frame
 * @param {(api: object) => void} o.build writes the timeline
 * @param {boolean} [o.vertical] 9:16 cut: UI shots pull back to the full screen width, object shots leave the bottom for text
 * @param {Array<[number, number]>} [o.segments] a cutdown: these spans of the master, back to back
 */
export function runEngine({ W = 1920, H = 1080, duration, screens, screenAt, drawUI = () => {}, preload = [], build, vertical = false, segments = null }) {
  const $ = (id) => document.getElementById(id);
  // (A find over [data-part] rather than a built selector: the HyperFrames linter flags template-literal selectors.)
  const part = (scr, n) => [...scr.querySelectorAll("[data-part]")].find((e) => e.dataset.part === n);

  // ---- Live screen. Captured at 3 px per point times the render's pixel ratio (4K renders at 2×), so text stays sharp.
  const src = $("src"), sctx = src.getContext("2d"), host = $("scr-host");
  const K = 3 * (window.devicePixelRatio || 1), CW = 402 * K, CH = 874 * K;
  src.width = CW; src.height = CH;
  Object.assign($("src-content").style, { width: `${CW}px`, height: `${CH}px` });
  host.style.transform = `scale(${K})`;
  const all = Object.values(screens);
  all.forEach((el) => { el.style.display = "none"; host.appendChild(el); });
  const showScreen = (el) => all.forEach((s) => { const d = s === el ? "block" : "none"; if (s.style.display !== d) s.style.display = d; });
  const live = "layoutSubtree" in src && typeof sctx.drawElementImage === "function";

  // ---- Three.
  const world = createWorld($("gl"), W, H);
  const { camera, composer, bokeh, dither, phone, screenMat, applyLight, toWorld, HERO } = world;
  const screenTex = new THREE.CanvasTexture(src);
  screenTex.colorSpace = THREE.SRGBColorSpace;
  screenTex.anisotropy = world.renderer.capabilities.getMaxAnisotropy();
  screenMat.map = screenTex; screenMat.needsUpdate = true;

  // ---- State the timeline animates.
  // cam: spherical around the target (yaw/elev deg, dist cm), target t*, focus point f*, fstop, max blur, exposure,
  // ui (0 = object shot: level with the floor; 1 = UI close-up: level with the screen).
  const cam = { yaw: 40, elev: -8, dist: 82, tx: 0, ty: 0, tz: 0, fov: LENS[85], fx: 0, fy: 0, fz: 0, fstop: 2.8, blur: 0.012, expo: 1, ui: 0 };
  // One studio light; keep it constant through a product film (only the screen changes).
  const L = { keyElev: 55, keyAz: -53, keyTemp: 5800, keyInt: 1, keySize: 1, keyAngle: 17, fill: 0.3, rim: 0.6, rimY: 100, kick: 0, screen: 0 };
  const P = { yaw: 0 }; // the phone's turn (deg); its lean-back is fixed in world.js
  const scr = { bright: 1.05 };
  const lockup = { card: 0, name: 0, nameX: 14, line: 0, avail: 0 };

  function render(t) {
    showScreen(screens[screenAt(t)]);
    drawUI(t);
    phone.position.copy(HERO);
    phone.rotation.set(world.PITCH, THREE.MathUtils.degToRad(P.yaw), 0);
    phone.updateMatrixWorld(true);
    const yw = THREE.MathUtils.degToRad(cam.yaw), el = THREE.MathUtils.degToRad(cam.elev);
    const dist = vertical ? (cam.ui ? cam.dist * 3.0 : Math.max(85, cam.dist * 1.45)) : cam.dist;
    const tx = vertical ? 0 : cam.tx, ty = cam.ty - (vertical && !cam.ui ? 0.1 * FRAME_H(dist, cam.fov) : 0);
    camera.position.copy(toWorld(tx + Math.sin(yw) * Math.cos(el) * dist, ty + Math.sin(el) * dist, cam.tz + Math.cos(yw) * Math.cos(el) * dist));
    // Object shots: a tripod level with the floor, so the lean-back reads as a lean.
    // UI close-ups: level with the screen, so the interface never sits askew.
    camera.up.set(0, 1, 0).lerp(toWorld(0, 1, 0).sub(toWorld(0, 0, 0)).normalize(), cam.ui).normalize();
    camera.lookAt(toWorld(tx, ty, cam.tz));
    camera.fov = cam.fov; camera.updateProjectionMatrix();
    bokeh.uniforms.focus.value = camera.position.distanceTo(toWorld(cam.fx, cam.fy, cam.fz));
    bokeh.uniforms.aperture.value = 0.00055 / cam.fstop;
    bokeh.uniforms.maxblur.value = cam.blur;
    world.contact.position.set(phone.position.x, 0.05, phone.position.z + 1.5);
    world.contact.material.opacity = 0.35 * Math.min(1, 0.3 + L.keyInt);
    applyLight(L);
    screenMat.color.setScalar(scr.bright);
    $("endcard").style.display = lockup.card ? "flex" : "none";
    $("lk-name").style.opacity = lockup.name;
    $("lk-name").style.transform = `translateX(${lockup.nameX}px)`;
    $("tag").style.opacity = lockup.line;
    $("avail").style.opacity = lockup.avail;
    dither.uniforms.uTime.value = t;
    world.renderer.toneMappingExposure = cam.expo;
    composer.render();
  }

  // Captures follow the browser's paint: update the DOM, ask for a paint, draw the HTML into the texture, render.
  // While measuring, seeks only lay out the DOM (no capture, no 3D), so measurement seeks stay fast.
  let measuring = false;
  function frame(t) {
    if (measuring) { showScreen(screens[screenAt(t)]); return; }
    if (live && typeof src.requestPaint === "function") {
      src.onpaint = () => {
        try { sctx.clearRect(0, 0, CW, CH); sctx.drawElementImage($("src-content"), 0, 0, CW, CH); screenTex.needsUpdate = true; } catch (e) {}
        render(t);
      };
      src.requestPaint();
    }
    render(t);
  }

  const images = preload.map((u) => { const i = new Image(); i.src = u; return i.decode(); });
  return Promise.all([document.fonts.ready, ...images]).then(() => {
    const CE = window.CustomEase;
    CE.create("travel", "M0,0 C0.65,0 0.35,1 1,1");
    CE.create("land", "M0,0 C0.16,1 0.3,1 1,1");
    const tl = gsap.timeline({ paused: true });
    const clock = { t: 0 };
    tl.to(clock, { t: duration, duration, ease: "none", onUpdate: () => frame(clock.t) }, 0);

    const fh = FRAME_H(UI_FILL, LENS[100]);
    const api = {
      tl, cam, L, P, scr, lockup, screens, part, fh, drift: "sine.inOut",
      /** Natural height of a collapsed element (to animate it open). */
      measure(el) { const h0 = el.style.height; el.style.height = "auto"; const h = el.scrollHeight; el.style.height = h0; return h; },
      /** Lay out a screen without rendering (before measuring static sizes). */
      show(name) { showScreen(screens[name]); },
      /** Where elements sit on the glass at given times, in phone-local cm: { key: [t, el] }. Call after the UI beats. */
      positions(spec) {
        measuring = true;
        const out = {};
        for (const [k, [t, el]] of Object.entries(spec)) {
          tl.seek(t, false);
          const r = el.getBoundingClientRect(), s = screens[screenAt(t)].getBoundingClientRect(), k2 = s.width / 402;
          out[k] = screenY((r.top + r.height / 2 - s.top) / k2);
        }
        tl.seek(0, false);
        measuring = false;
        return out;
      },
      /** A hard cut: the whole camera state set at once (shots join on cuts, not moves). */
      cut(at, shot) { tl.set(cam, shot, at); },
      /** A benefit line beside the phone; a two-beat line (.b-2) lands its second half a beat later. */
      benefit(id, at, out) {
        const el = $(id), second = el.querySelector(".b-2");
        tl.fromTo(el, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.35, ease: "land" }, at);
        if (second) tl.fromTo(second, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "none" }, at + 0.55);
        tl.to(el, { opacity: 0, duration: 0.2, ease: "none" }, out);
      },
      /** The end card, cut to on a strong beat: the mark is on, the name, the line and the availability follow. */
      endCard(at) {
        tl.set(lockup, { card: 1 }, at);
        tl.to(lockup, { name: 1, nameX: 0, duration: 0.45, ease: "land" }, at + 0.375);
        tl.to(lockup, { line: 1, duration: 0.45, ease: "land" }, at + 1.125);
        tl.fromTo("#tag", { y: 8 }, { y: 0, duration: 0.45, ease: "land" }, at + 1.125);
        tl.to(lockup, { avail: 1, duration: 0.45, ease: "land" }, at + 1.875);
      },
    };
    build(api);

    let main = tl;
    if (segments) {
      // A cutdown: its own clock, mapped onto the master's timeline segment by segment.
      const total = segments.reduce((a, [from, to]) => a + to - from, 0);
      const map = (t) => { let acc = 0; for (const [from, to] of segments) { if (t < acc + to - from) return from + t - acc; acc += to - from; } return segments.at(-1)[1]; };
      const p = { t: 0 };
      main = gsap.timeline({ paused: true });
      main.to(p, { t: total, duration: total, ease: "none", onUpdate: () => tl.seek(map(p.t), false) }, 0);
    }
    (window.__timelines ||= {})["main"] = main;
    main.seek(0);
    return main;
  });
}
