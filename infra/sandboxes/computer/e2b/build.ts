import { parseArgs } from "node:util";
import { defaultBuildLogger, Template } from "e2b";
import { COMPUTER_PROFILE, computerTemplate } from "./template.js";

const { values } = parseArgs({
  options: { image: { type: "string" }, name: { type: "string", default: "desktop" } },
});
if (!values.image) throw new Error("Pass --image <registry>/<repository>@sha256:<digest>");
// The SDK reads E2B_API_KEY, and E2B_DOMAIN or E2B_API_URL for a self-hosted E2B.
const built = await Template.build(computerTemplate(values.image), values.name, {
  ...COMPUTER_PROFILE,
  onBuildLogs: defaultBuildLogger(),
});
console.log(
  `Built the computer template ${built.name} (${built.templateId}, build ${built.buildId})`,
);
