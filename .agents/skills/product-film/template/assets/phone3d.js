// The anonymised phone: satin grey frame, polished chamfer, thin black bezel, a Dynamic Island-sized cutout,
// continuous corners, and a cover glass that mirrors the room. Close enough to read as "a phone", never as an iPhone.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

export const PW = 0.71, PH = 1.5, PD = 0.08, PR = 0.088, BZ = 0.0165;
const SW = PW - 2 * BZ, SH = PH - 2 * BZ;

export function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  const x0 = -w / 2, y0 = -h / 2, x1 = w / 2, y1 = h / 2;
  const p = Math.min(1.6 * r, w / 2, h / 2);
  const c = 0.45 * p;
  s.moveTo(x0 + p, y0);
  s.lineTo(x1 - p, y0); s.bezierCurveTo(x1 - c, y0, x1, y0 + c, x1, y0 + p);
  s.lineTo(x1, y1 - p); s.bezierCurveTo(x1, y1 - c, x1 - c, y1, x1 - p, y1);
  s.lineTo(x0 + p, y1); s.bezierCurveTo(x0 + c, y1, x0, y1 - c, x0, y1 - p);
  s.lineTo(x0, y0 + p); s.bezierCurveTo(x0, y0 + c, x0 + c, y0, x0 + p, y0);
  return s;
}
export const remapUV = (geo, w, h) => {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / w + 0.5, uv.getY(i) / h + 0.5);
  return geo;
};
/** The phone alone (units: dm, screen facing +Z, centred on the origin). */
export function createPhone() {
  const phone = new THREE.Group();

  const bevel = 0.008;
  const bodyGeo = new THREE.ExtrudeGeometry(roundedRect(PW - 2 * bevel, PH - 2 * bevel, PR - bevel), {
    depth: PD - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 8, curveSegments: 64,
  });
  bodyGeo.translate(0, 0, -(PD - 2 * bevel) / 2);
  const bodyMat = new THREE.MeshPhysicalMaterial({ color: 0x9c9ca2, metalness: 1, roughness: 0.38, anisotropy: 0.7, envMapIntensity: 1.4 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.castShadow = true;
  phone.add(body);

  const chamferShape = roundedRect(PW - 0.002, PH - 0.002, PR - 0.001);
  chamferShape.holes.push(roundedRect(PW - 0.012, PH - 0.012, PR - 0.006));
  const chamfer = new THREE.Mesh(remapUV(new THREE.ShapeGeometry(chamferShape, 64), PW, PH), new THREE.MeshPhysicalMaterial({ color: 0xdcdce0, metalness: 1, roughness: 0.12, envMapIntensity: 1.6 }));
  chamfer.position.z = PD / 2 + 0.0004;
  phone.add(chamfer);

  const bezel = new THREE.Mesh(new THREE.ShapeGeometry(roundedRect(PW - 0.012, PH - 0.012, PR - 0.006), 64), new THREE.MeshBasicMaterial({ color: 0x030304 }));
  bezel.position.z = PD / 2 + 0.0005;
  phone.add(bezel);

  const screenMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  const screen = new THREE.Mesh(remapUV(new THREE.ShapeGeometry(roundedRect(SW, SH, PR - BZ * 0.9), 64), SW, SH), screenMat);
  screen.position.z = PD / 2 + 0.001;
  phone.add(screen);

  const islandW = 0.313 * SW, islandH = 0.093 * SW;
  const islandY = SH / 2 - 0.027 * SW - islandH / 2;
  const island = new THREE.Mesh(new THREE.ShapeGeometry(roundedRect(islandW, islandH, islandH / 2), 48), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  island.position.set(0, islandY, PD / 2 + 0.0016);
  const lensX = islandW / 2 - islandH / 2;
  const lens = new THREE.Mesh(new THREE.CircleGeometry(islandH * 0.22, 32), new THREE.MeshBasicMaterial({ color: 0x0d0d14 }));
  lens.position.set(lensX, islandY, PD / 2 + 0.0017);
  phone.add(island, lens);

  // The cover glass mirrors the room it stands in: a dim ceiling, the lit floor, the softbox up-left (equirect map),
  // so a black screen carries a faint veil that shifts with the camera, never a painted sweep.
  const room = document.createElement("canvas");
  room.width = 1024; room.height = 512;
  const rg = room.getContext("2d"), vg = rg.createLinearGradient(0, 0, 0, 512);
  [[0, "#1c1c1e"], [0.45, "#38383b"], [0.52, "#58585b"], [1, "#4a4a4d"]].forEach(([o, c]) => vg.addColorStop(o, c));
  rg.fillStyle = vg; rg.fillRect(0, 0, 1024, 512);
  rg.filter = "blur(18px)"; rg.fillStyle = "#f2f2f2"; rg.fillRect(300, 70, 150, 90); rg.filter = "none";
  const roomTex = new THREE.CanvasTexture(room);
  roomTex.mapping = THREE.EquirectangularReflectionMapping; roomTex.colorSpace = THREE.SRGBColorSpace;
  const coverGlass = new THREE.Mesh(
    new THREE.ShapeGeometry(roundedRect(PW - 0.012, PH - 0.012, PR - 0.006), 64),
    new THREE.MeshPhysicalMaterial({ color: 0x000000, metalness: 0, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02, envMap: roomTex, envMapIntensity: 10, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  coverGlass.position.z = PD / 2 + 0.0026;
  coverGlass.renderOrder = 40;
  phone.add(coverGlass);

  // Buttons: the frame's own satin metal, each sitting 0.1 mm into a dark slot so it reads as machined.
  // (The extruded sides reflect the room darker than a flat face would, so the buttons take a darker satin to match.)
  const btnMat = new THREE.MeshPhysicalMaterial({ color: 0x4a4a4f, metalness: 1, roughness: 0.38, envMapIntensity: 1.4 });
  const slotMat = new THREE.MeshBasicMaterial({ color: 0x0a0a0b });
  for (const [y, h] of [[0.3, 0.16], [0.06, 0.1]]) {
    const slot = new THREE.Mesh(new RoundedBoxGeometry(0.003, h + 0.004, 0.03, 3, 0.0014), slotMat);
    slot.position.set(PW / 2 - 0.0005, y, 0);
    const b = new THREE.Mesh(new RoundedBoxGeometry(0.006, h, 0.026, 4, 0.0029), btnMat);
    b.position.set(PW / 2 + 0.0009, y, 0);
    b.castShadow = true;
    phone.add(slot, b);
  }

  return { phone, screenMat, body, glassMat: coverGlass.material };
}
