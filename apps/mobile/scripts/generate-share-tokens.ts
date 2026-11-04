import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SHARE_TOKENS_SWIFT_PATH, shareTokensSwift } from "../lib/share-extension-tokens";

writeFileSync(
  fileURLToPath(new URL(`../${SHARE_TOKENS_SWIFT_PATH}`, import.meta.url)),
  shareTokensSwift(),
);
