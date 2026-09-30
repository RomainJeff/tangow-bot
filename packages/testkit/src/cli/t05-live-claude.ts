export const T05_IMAGE = "rakazo-j3d2/computer:test";
export const T05_FAKE_CLAUDE = "packages/testkit/src/cli/t05-fake-claude.mjs";
export const T05_REPLAY_COMMAND =
  "RAKAZO_T05_OFFLINE_REHEARSAL=1 pnpm exec tsx packages/testkit/src/cli/t05-live-claude.ts --replay";

/** Ordered offline assertions: no subscription connection is needed. */
export const t05ReplayChecks = [
  "missing-credit-is-authentication",
  "two-turns-resume-same-session",
  "private-config-has-no-access-credential-after-stop",
] as const;

export type T05RunnerMode = "prepare" | "replay" | "live";

export function t05RunnerMode(argv: string[]): T05RunnerMode {
  const replay = argv.includes("--replay");
  const live = argv.includes("--live");
  if (replay && live) throw new Error("Live and replay modes cannot be combined.");
  if (replay) return "replay";
  if (live) return "live";
  return "prepare";
}

function receipt(mode: T05RunnerMode): string[] {
  return [
    `T05_MODE=${mode}`,
    `T05_IMAGE=${T05_IMAGE}`,
    `T05_FAKE_CLAUDE=${T05_FAKE_CLAUDE}`,
    `T05_OFFLINE_CHECKS=${t05ReplayChecks.join(",")}`,
    `T05_REPLAY_COMMAND=${T05_REPLAY_COMMAND}`,
  ];
}

const mode = t05RunnerMode(process.argv.slice(2));
if (mode === "live") {
  throw new Error(
    "T05 live is gated on a completed offline rehearsal and is intentionally not run by default.",
  );
}
if (mode === "replay" && process.env.RAKAZO_T05_OFFLINE_REHEARSAL !== "1") {
  throw new Error("Set RAKAZO_T05_OFFLINE_REHEARSAL=1 to run the isolated replay.");
}
console.log(receipt(mode).join("\n"));
