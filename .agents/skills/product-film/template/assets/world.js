// The room: one grey sweep, one phone, one light rig whose values animate (product films keep it constant).
// Units: centimetres. Phone-local frame: origin at the screen centre, +X right, +Y up, +Z out of the screen.
import * as THREE from "three";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { createPhone, PW, PH, PD, BZ } from "./phone3d.js";

export const SCREEN_W = (PW - 2 * BZ) * 10; // 6.77 cm
export const SCREEN_H = (PH - 2 * BZ) * 10; // 14.67 cm

/** Approximate blackbody colour (Tanner Helland), linear-ish RGB in 0..1. */
export function kelvin(k) {
  const t = k / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; } else { r = 329.7 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); }
  if (t >= 66) b = 255; else if (t <= 19) b = 0; else b = 138.52 * Math.log(t - 10) - 305.04;
  const c = (v) => Math.min(255, Math.max(0, v)) / 255;
  return new THREE.Color().setRGB(c(r), c(g), c(b), THREE.SRGBColorSpace).lerp(new THREE.Color(1, 1, 1), 0.5);
}

function sweepGeometry() {
  // Floor to z = -100, a 400 cm radius cove (no visible horizon), then the wall at z = -500 up to 4000 cm.
  const pts = [];
  for (let z = 4000; z > 900; z -= 300) pts.push([z, 0]);
  for (let z = 900; z > -100; z -= 30) pts.push([z, 0]);
  for (let i = 0; i <= 48; i++) { const th = (i / 48) * (Math.PI / 2); pts.push([-100 - 400 * Math.sin(th), 400 - 400 * Math.cos(th)]); }
  for (let y = 440; y <= 1200; y += 40) pts.push([-500, y]);
  for (let y = 1600; y <= 4000; y += 400) pts.push([-500, y]);
  const xs = [];
  for (let x = -4000; x < -900; x += 300) xs.push(x);
  for (let x = -900; x <= 900; x += 30) xs.push(x);
  for (let x = 1200; x <= 4000; x += 300) xs.push(x);
  const pos = [], idx = [];
  for (const [z, y] of pts) for (const x of xs) pos.push(x, y, z);
  const nx = xs.length;
  for (let j = 0; j < pts.length - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const DitherShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uAmount: { value: 1.6 / 255 } },
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime; uniform float uAmount; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime * 7.31) * 43758.5453); }
    void main(){ vec4 c = texture2D(tDiffuse, vUv); float n = h(gl_FragCoord.xy) + h(gl_FragCoord.yx + 17.0) - 1.0; c.rgb += n * uAmount + n * 0.012 * dot(c.rgb, vec3(0.33)); gl_FragColor = c; }`,
};

export function createWorld(canvas, W, H) {
  RectAreaLightUniformsLib.init();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(W, H, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Neutral tone mapping keeps the UI's colours and whites true; only highlights are compressed.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(13.6, W / H, 1, 3000);

  // Reflections: an environment of emissive cards shaped like the key and the rim.
  const studio = new THREE.Scene();
  // A grey room around the cards, so glass at grazing angles mirrors the studio instead of going black.
  studio.background = new THREE.Color(0x3a3a3d);
  const card = (w, h, k, p) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k, k), side: THREE.DoubleSide })); m.position.set(...p); m.lookAt(0, 0, 0); studio.add(m); };
  card(6, 3.6, 6, [-4.8, 6.6, 3.6]);
  card(0.6, 4.5, 4, [2.7, 1.8, -3.6]);
  card(9, 9, 0.5, [7.5, 1.2, 4.5]);
  const floorC = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 0.3, 0.3) }));
  floorC.rotation.x = -Math.PI / 2; floorC.position.y = -3; studio.add(floorC);
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(studio, 0.03).texture;

  // The sweep.
  const cycMat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.3, 0.3, 0.305), roughness: 0.9, metalness: 0, envMapIntensity: 0.15, side: THREE.DoubleSide });
  const cyc = new THREE.Mesh(sweepGeometry(), cycMat);
  cyc.receiveShadow = true;
  scene.add(cyc);

  // The phone in its hero pose.
  const { phone: phoneInner, screenMat, glassMat } = createPhone();
  phoneInner.scale.setScalar(10);
  phoneInner.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
  const phone = new THREE.Group(); // pose group (hero pose + small "present" turns)
  const rig = new THREE.Group(); // phone-local frame (screen centre), carries the phone
  rig.add(phoneInner);
  phone.add(rig);
  // Leaning back like a phone on a stand (16°), hovering just 1.5 cm off the floor.
  const PITCH = THREE.MathUtils.degToRad(-16);
  const HERO = new THREE.Vector3(0, 1.5 + (PH * 10) / 2 * Math.cos(PITCH) + 0.4, 0);
  phone.position.copy(HERO);
  phone.rotation.x = PITCH;
  scene.add(phone);
  // The camera and the lights live in the hero pose's frame, so the phone's own turns and its final sink read on screen.
  const anchor = new THREE.Group();
  anchor.position.copy(HERO);
  anchor.rotation.x = PITCH;
  scene.add(anchor);

  const aoCanvas = document.createElement("canvas");
  aoCanvas.width = aoCanvas.height = 256;
  const ag = aoCanvas.getContext("2d"), grd = ag.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, "rgba(0,0,0,1)"); grd.addColorStop(0.45, "rgba(0,0,0,0.55)"); grd.addColorStop(1, "rgba(0,0,0,0)");
  ag.fillStyle = grd; ag.fillRect(0, 0, 256, 256);
  const contact = new THREE.Mesh(new THREE.PlaneGeometry(16, 7), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(aoCanvas), transparent: true, opacity: 0.35, depthWrite: false }));
  contact.rotation.x = -Math.PI / 2;
  contact.position.set(0, 0.05, 0);
  contact.renderOrder = 1;
  scene.add(contact);

  // Lights.
  const key = new THREE.SpotLight(0xffffff, 0, 0, THREE.MathUtils.degToRad(17), 1, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 50; key.shadow.camera.far = 1200;
  key.shadow.radius = 24; key.shadow.blurSamples = 32; key.shadow.bias = -0.0004;
  scene.add(key, key.target);
  const keyArea = new THREE.RectAreaLight(0xffffff, 0, 200, 120);
  scene.add(keyArea);
  // Rim and fill are narrow spots on the phone so they shape the object without lighting the room.
  const rim = new THREE.SpotLight(kelvin(7000), 0, 0, THREE.MathUtils.degToRad(5), 0.6, 0);
  scene.add(rim, rim.target);
  const fill = new THREE.SpotLight(0xffffff, 0, 0, THREE.MathUtils.degToRad(5), 0.8, 0);
  scene.add(fill, fill.target);
  const screenLight = new THREE.RectAreaLight(0xdde4ff, 0, SCREEN_W, SCREEN_H);
  rig.add(screenLight);
  // RectAreaLight emits along its local -Z; turned to face +Z, out of the screen.
  screenLight.position.set(0, 0, PD * 5 + 0.3);
  screenLight.rotation.set(0, Math.PI, 0);
  const ambient = new THREE.HemisphereLight(0xffffff, 0x8a8a8f, 0);
  scene.add(ambient);
  // A side kicker for the opening, so the frame's side reads as satin metal.
  const kick = new THREE.SpotLight(0xffffff, 0, 0, THREE.MathUtils.degToRad(8), 0.7, 0);
  scene.add(kick, kick.target);

  // Post: depth of field, tone mapping, dither (dark gradients must not band).
  // Multisampled HDR target: the chamfer's thin highlights must not alias into dots.
  const rt = new THREE.WebGLRenderTarget(W * (window.devicePixelRatio || 1), H * (window.devicePixelRatio || 1), { samples: 4, type: THREE.HalfFloatType });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(window.devicePixelRatio || 1);
  composer.setSize(W, H);
  composer.addPass(new RenderPass(scene, camera));
  const bokeh = new BokehPass(scene, camera, { focus: 50, aperture: 0.0002, maxblur: 0.008 });
  composer.addPass(bokeh);
  composer.addPass(new OutputPass());
  const dither = new ShaderPass(DitherShader);
  composer.addPass(dither);

  const tmp = new THREE.Vector3();
  const toWorld = (x, y, z) => { anchor.updateMatrixWorld(true); return anchor.localToWorld(tmp.set(x, y, z)).clone(); };
  /** Light state: elevation/azimuth (deg, phone-local), colour temperature, intensities. */
  function applyLight(L) {
    const d = 270, el = THREE.MathUtils.degToRad(L.keyElev), az = THREE.MathUtils.degToRad(L.keyAz);
    const kp = toWorld(Math.sin(az) * Math.cos(el) * d, Math.sin(el) * d, Math.cos(az) * Math.cos(el) * d);
    const tgt = toWorld(0, 0, 0);
    key.position.copy(kp); key.target.position.copy(tgt);
    key.color.copy(kelvin(L.keyTemp));
    key.intensity = L.keyInt * 4.2;
    key.penumbra = 1;
    // A small (hard) sun casts a crisp long shadow; the big morning softbox a soft one.
    key.shadow.radius = 3 + 40 * L.keySize;
    key.angle = THREE.MathUtils.degToRad(L.keyAngle || 17);
    keyArea.position.copy(kp); keyArea.lookAt(tgt);
    keyArea.color.copy(kelvin(L.keyTemp));
    keyArea.intensity = L.keyInt * 1.6;
    keyArea.width = 200 * L.keySize; keyArea.height = 120 * L.keySize;
    rim.position.copy(toWorld(90, 60 + (L.rimY || 0), -120)); rim.target.position.copy(tgt); rim.intensity = L.rim * 3.0;
    kick.position.copy(toWorld(60, 20, 20)); kick.target.position.copy(toWorld(3.4, 0, -0.4)); kick.intensity = (L.kick || 0) * 1.2;
    fill.position.copy(toWorld(250, 40, 150)); fill.target.position.copy(tgt); fill.intensity = L.fill * 1.2;
    // The room's bounce: lifts the shadows so they read soft and grey, never black.
    ambient.intensity = 0.9 * L.fill + 0.12 * L.keyInt + 0.004;
    scene.environmentIntensity = 0.1 + 0.9 * L.keyInt;
    // The glass mirrors the room only as brightly as the room is lit.
    glassMat.envMapIntensity = 10 * (0.1 + 0.9 * Math.min(1, L.keyInt));
    screenLight.intensity = L.screen * 7;
  }

  return { contact, renderer, scene, camera, composer, bokeh, dither, cyc, phone, rig, anchor, phoneInner, screenMat, applyLight, toWorld, HERO, PITCH };
}
