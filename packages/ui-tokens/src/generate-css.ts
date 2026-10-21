import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderTokensCss } from "./render-css.js";

writeFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), renderTokensCss());
