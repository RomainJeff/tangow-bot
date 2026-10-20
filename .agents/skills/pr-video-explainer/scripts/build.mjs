#!/usr/bin/env node
// Usage: node build.mjs <project-dir>   (project-dir contains story.json)
// TTS each scene's `vo`, measure it, time scenes around the narration, write index.html.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = resolve(process.argv[2] || ".");
const here = dirname(fileURLToPath(import.meta.url));
const story = JSON.parse(readFileSync(join(dir, "story.json"), "utf8"));

const npx = join(homedir(), ".npm/_npx");
const HF = process.env.HF || readdirSync(npx).map(d => join(npx, d, "node_modules/.bin/hyperframes")).find(existsSync);
if (!HF) throw new Error("hyperframes CLI not found: run `npx hyperframes --version` once or set HF=");
const env = { ...process.env, HYPERFRAMES_PYTHON: process.env.HYPERFRAMES_PYTHON || join(homedir(), ".cache/hyperframes/kokoro-venv/bin/python") };

const voice = story.voice || "am_michael", speed = story.speed || 1.0;
const LEAD = story.lead ?? 0.6, TAIL = story.tail ?? 0.7, XFADE = story.xfade ?? 0.5;

mkdirSync(join(dir, "assets"), { recursive: true });
if (!existsSync(join(dir, "hyperframes.json")))
  writeFileSync(join(dir, "hyperframes.json"), JSON.stringify({ paths: { blocks: "compositions", components: "compositions/components", assets: "assets" } }, null, 2));

const probe = f => +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim();

// TTS, cached by text hash so editing one scene only re-voices that scene
const keep = new Set();
let t = 0;
story.scenes.forEach((sc, i) => {
  sc.voice = 0;
  if (sc.vo) {
    const h = createHash("sha1").update(`${voice}|${speed}|${sc.vo}`).digest("hex").slice(0, 10);
    sc.audio = `assets/vo-${String(i).padStart(2, "0")}-${h}.wav`;
    keep.add(sc.audio.slice(7));
    const f = join(dir, sc.audio);
    if (!existsSync(f)) {
      process.stdout.write(`tts scene ${i}… `);
      execFileSync(HF, ["tts", sc.vo, "-v", voice, "-s", String(speed), "-o", f, "--json"], { env, stdio: ["ignore", "pipe", "inherit"] });
    }
    sc.voice = probe(f);
    console.log(`scene ${i} ${sc.type}: ${sc.voice.toFixed(2)}s`);
  }
  sc.lead = LEAD;
  sc.dur = +(Math.max(sc.min || 0, LEAD + sc.voice + TAIL)).toFixed(2);
  sc.t0 = +t.toFixed(2);
  t += sc.dur - XFADE;
});
for (const f of readdirSync(join(dir, "assets"))) if (/^vo-.*\.wav$/.test(f) && !keep.has(f)) unlinkSync(join(dir, "assets", f));

const last = story.scenes.at(-1);
last.final = true;
const total = +(last.t0 + last.dur).toFixed(2);

const clips = story.scenes.flatMap((sc, i) => [
  `      <div id="s${i}" class="scene clip" data-start="${sc.t0}" data-duration="${sc.dur}" data-track-index="${1 + (i % 2)}"></div>`,
  sc.audio && `      <audio id="a${i}" class="clip" src="${sc.audio}" data-start="${(sc.t0 + sc.lead).toFixed(2)}" data-duration="${sc.voice.toFixed(2)}" data-track-index="3" data-volume="1"></audio>`,
]).filter(Boolean).join("\n");

const data = { ...story, xfade: XFADE, total };
const html = readFileSync(join(here, "../template/index.html"), "utf8")
  .replace("__TOTAL__", total)
  .replace("<!--CLIPS-->", clips)
  .replace("/*STORY*/null", JSON.stringify(data).replace(/</g, "\\u003c"));
writeFileSync(join(dir, "index.html"), html);
console.log(`index.html: ${story.scenes.length} scenes, ${total}s`);
