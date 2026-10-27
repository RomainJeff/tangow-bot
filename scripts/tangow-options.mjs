import { parseArgs } from "node:util";

export const help = `Tangow — operate a Rakazo source deployment

Usage: tangow [--path <checkout>] [--sudo] <command>

  setup                     Configure, build and verify the current checkout
  status                    Show running revision, provider and services
  update                    Update main, build for the configured provider and restart
  restart                   Restart application services and check readiness
  logs [service] [--follow] Show the last 100 log lines (default: api)
  computers build           Rebuild Docker worker/computer or E2B worker/desktop builds
  provider e2b              Configure E2B and migrate existing computer homes
  provider docker           Migrate E2B bot/shared volumes and switch to Docker
  cleanup --yes             Remove unused build cache and images, never volumes

Options:
  --path <checkout>         Deployment checkout (default: this repository)
  --sudo                    Use sudo -n for Docker/private config, never Git
  --computer-image <image>  Pushable registry/repository:tag for E2B builds/setup
  --migrate-existing        Consent to stopping computers and migrating provider data
  --dry-run                 Describe the operation without changing anything
  --help                    Show this help

Node 22.22.2+, pnpm and installed dependencies are needed for E2B template builds.
Defaults: .env.tangow.json (sudo, computerImage). Update detects E2B from its
private Compose override and rebuilds both templates. Replace existing computers
from Settings > Computer; busy computers are skipped there. See docs/tangow.md.
`;
export const services = ["api", "worker", "web"];

export function mainOptions() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args: process.argv.slice(2),
    options: {
      path: { type: "string" },
      sudo: { type: "boolean" },
      "computer-image": { type: "string" },
      "migrate-existing": { type: "boolean" },
      "dry-run": { type: "boolean" },
      follow: { type: "boolean" },
      yes: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help || !positionals.length) return { values, positionals, help: true };
  const [command, subcommand, ...rest] = positionals;
  if (
    rest.length ||
    !["setup", "status", "update", "restart", "logs", "computers", "provider", "cleanup"].includes(
      command,
    ) ||
    (command === "computers"
      ? subcommand !== "build"
      : command === "provider"
        ? !["e2b", "docker"].includes(subcommand)
        : command === "logs"
          ? subcommand &&
            ![...services, "supervisor", "migrate", "worker-image"].includes(subcommand)
          : subcommand !== undefined)
  )
    throw new Error("Unknown command. Run tangow --help.");
  const build = command === "computers" || command === "update" || command === "setup";
  const setup = command === "provider" && subcommand === "e2b";
  const migration = command === "provider";
  if (
    (values["computer-image"] && !build && !setup) ||
    (values["migrate-existing"] && !migration) ||
    (values.follow && command !== "logs") ||
    (values.yes && command !== "cleanup")
  )
    throw new Error("Option does not apply to this command. Run tangow --help.");
  if (
    values["computer-image"] &&
    (!values["computer-image"].includes("/") ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*:[a-zA-Z0-9_.-]+$/.test(values["computer-image"]))
  )
    throw new Error("Use --computer-image <registry>/<repository>:<tag>.");
  return { values, positionals };
}
