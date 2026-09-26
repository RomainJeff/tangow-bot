/**
 * Renders the native splash screen's frozen frame: the placeholder bot
 * (shape `cercle`, monochrome), asleep and looking down — the exact state
 * `LAUNCH_CHOREOGRAPHY`'s first step starts the animated splash from, so the
 * native → JS handoff has no visible jump.
 *
 * Reproducible by design: run `pnpm --filter @rakazo/mobile generate-splash-assets`
 * any time the bloub engine's `somnolent` expression or the `cercle` shape
 * changes, instead of hand-exporting a PNG.
 */
import { fileURLToPath } from "node:url";
import { SPECIAL_BOT_COLORS } from "@rakazo/contracts";
import { BotEngine, EXPRESSION_BY_ID, LAUNCH_CHOREOGRAPHY, RAYON, SHAPES } from "@rakazo/core";
import sharp from "sharp";

/** Mirrors `BLOUB_HALF_VIEWBOX` in `components/bot-avatar.tsx`. */
const HALF_VIEWBOX = RAYON * 1.12;
const OUTPUT_SIZE = 1024;

const [INK, WHITE] = SPECIAL_BOT_COLORS;

/** Same rule `OrganicAvatar` uses to pick the eye colour and the outline from the body fill. */
function eyeColors(fill: string): { paper: string; outline: string | null } {
  return fill === WHITE ? { paper: "#101014", outline: INK } : { paper: "#FFFFFF", outline: null };
}

function renderSvg(fill: string): string {
  const cercle = SHAPES.find((shape) => shape.id === "cercle");
  if (!cercle) throw new Error("Missing the 'cercle' shape in @rakazo/core's SHAPES.");
  const asleep = LAUNCH_CHOREOGRAPHY[0]!;
  if (asleep.mood !== "somnolent" || !asleep.look) {
    throw new Error("The native splash expects the choreography to start asleep, looking down.");
  }

  const engine = new BotEngine(RAYON, "idle", cercle.radii, EXPRESSION_BY_ID.get(asleep.mood));
  // `morph = 0`: the look applies immediately, no fade-in needed for a still frame.
  engine.setLook(asleep.look, 0, 0);
  const frame = engine.sample(0.05);

  const { paper, outline } = eyeColors(fill);
  const eyes = frame.eyes
    .map(
      (eye) =>
        `<path d="${eye.d}" transform="${eye.matrix}" opacity="${eye.alpha}" fill="${paper}" />`,
    )
    .join("");
  const outlinePath = outline
    ? `<path d="${frame.bodyPath}" fill="none" stroke="${outline}" stroke-width="${RAYON * 0.06}" />`
    : "";

  const vb = HALF_VIEWBOX;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OUTPUT_SIZE}" height="${OUTPUT_SIZE}" viewBox="${-vb} ${-vb} ${vb * 2} ${vb * 2}">
  <defs><clipPath id="body"><path d="${frame.bodyPath}" /></clipPath></defs>
  <g opacity="${frame.bodyAlpha}">
    <path d="${frame.bodyPath}" fill="${fill}" />
    <g clip-path="url(#body)">${eyes}</g>
    ${outlinePath}
  </g>
</svg>`;
}

async function renderPng(fill: string, outPath: string): Promise<void> {
  const svg = renderSvg(fill);
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

async function main() {
  const assetsDir = fileURLToPath(new URL("../assets/", import.meta.url));
  await renderPng(INK, `${assetsDir}splash-icon.png`);
  await renderPng(WHITE, `${assetsDir}splash-icon-dark.png`);
  // eslint-disable-next-line no-console
  console.log(`Wrote ${assetsDir}splash-icon.png and ${assetsDir}splash-icon-dark.png`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
