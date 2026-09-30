import { describe, expect, it } from "vitest";
import { T05_REPLAY_COMMAND, t05ReplayChecks, t05RunnerMode } from "./t05-live-claude.ts";

describe("T05 Claude native proof driver", () => {
  it("keeps the offline rehearsal ahead of live and names every required assertion", () => {
    expect(t05RunnerMode(["--replay"])).toBe("replay");
    expect(T05_REPLAY_COMMAND).toContain("--replay");
    expect(t05ReplayChecks).toEqual([
      "missing-credit-is-authentication",
      "two-turns-resume-same-session",
      "private-config-has-no-access-credential-after-stop",
    ]);
  });

  it("rejects a live attempt until the offline rehearsal is selected separately", () => {
    expect(() => t05RunnerMode(["--live", "--replay"])).toThrow(
      "Live and replay modes cannot be combined",
    );
    expect(t05RunnerMode(["--live"])).toBe("live");
  });
});
