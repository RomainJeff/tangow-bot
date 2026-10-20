import { describe, expect, it } from "vitest";
import type { VolumeGrant, VolumeRow, WorkerLaunch } from "./worker-plan.js";
import { authorizeMounts, deriveRunNeeds, planLaunch, volumeMountPath } from "./worker-plan.js";

const scope = { botId: "bot_a", spaceId: "space_a" };
const e2b = { kind: "e2b", readOnlyMounts: false };
const privateA: VolumeRow = {
  id: "vol_private_a",
  kind: "bot_private",
  spaceId: "space_a",
  botId: "bot_a",
  providerKind: "e2b",
  providerRef: "rakazo-volume-vol_private_a",
  writerAttemptId: null,
};
const sharedA: VolumeRow = {
  id: "vol_shared_a",
  kind: "space_shared",
  spaceId: "space_a",
  botId: null,
  providerKind: "e2b",
  providerRef: "rakazo-volume-vol_shared_a",
  writerAttemptId: null,
};

describe("authorizeMounts", () => {
  it("mounts the bot's private volume and the space volume at fixed paths", () => {
    expect(
      authorizeMounts(
        scope,
        [
          { volumeId: "vol_private_a", access: "rw" },
          { volumeId: "vol_shared_a", access: "rw" },
        ],
        [privateA, sharedA],
        e2b,
      ),
    ).toEqual({
      ok: true,
      mounts: [
        {
          volumeId: "vol_private_a",
          volumeRef: "rakazo-volume-vol_private_a",
          path: "/workspace/bots/bot_a",
          scope: "private",
          access: "rw",
        },
        {
          volumeId: "vol_shared_a",
          volumeRef: "rakazo-volume-vol_shared_a",
          path: "/workspace/shared",
          scope: "shared",
          access: "rw",
        },
      ],
    });
  });

  it.each([
    ["volume_not_found", { volumeId: "vol_missing", access: "rw" }, privateA, e2b],
    [
      "volume_not_provisioned",
      { volumeId: "vol_private_a", access: "rw" },
      { ...privateA, providerRef: null },
      e2b,
    ],
    [
      "provider_mismatch",
      { volumeId: "vol_private_a", access: "rw" },
      { ...privateA, providerKind: "other-cloud" },
      e2b,
    ],
    ["read_only_unsupported", { volumeId: "vol_private_a", access: "ro" }, privateA, e2b],
  ] as const)("refuses %s", (code, grant, row, provider) => {
    expect(authorizeMounts(scope, [grant], [row], provider)).toEqual({
      ok: false,
      refusal: { code, volumeId: grant.volumeId },
    });
  });

  it("grants read-only when the provider enforces it", () => {
    const result = authorizeMounts(scope, [{ volumeId: "vol_shared_a", access: "ro" }], [sharedA], {
      kind: "e2b",
      readOnlyMounts: true,
    });
    expect(result.ok && result.mounts.map((mount) => mount.access)).toEqual(["ro"]);
  });
});

describe("volumeMountPath", () => {
  it.each(["../escape", "a/b", "", "x".repeat(65)])("rejects the unsafe bot id %j", (botId) => {
    expect(() => volumeMountPath({ kind: "bot_private", botId })).toThrow(
      "Invalid bot id for a mount path",
    );
  });
});

describe("the launch a run gets from its tools and its bot's computer", () => {
  const base = {
    runId: "run_a",
    botId: "bot_a",
    spaceId: "space_a",
    attemptId: "attempt_a",
    fence: 2,
    privateVolumeId: "vol_private_a",
    sharedVolumeId: "vol_shared_a",
  };
  const onVolumes = { id: "computer_a", homeStorage: "volumes" as const };
  const launch = (volumes: VolumeGrant[], computer: WorkerLaunch["computer"]) => ({
    mode: "worker",
    runId: "run_a",
    botId: "bot_a",
    spaceId: "space_a",
    attemptId: "attempt_a",
    fence: 2,
    volumes,
    computer,
  });
  const files = { guestTools: true, computerTools: true };

  it.each([
    [
      "a team bot works in its own volume and the space's",
      { ...files, computerScope: "team" as const },
      { ...base, computer: onVolumes },
      launch(
        [
          { volumeId: "vol_private_a", access: "rw" },
          { volumeId: "vol_shared_a", access: "rw" },
        ],
        { mode: "on_use", computerId: "computer_a" },
      ),
    ],
    [
      "a team bot whose team home is still a snapshot stays in process, shared slot included",
      { ...files, computerScope: "team" as const },
      { ...base, computer: { id: "computer_a", homeStorage: "snapshot" as const } },
      { mode: "in_process", reason: "home_not_migrated" },
    ],
    [
      "a dedicated bot mounts shared skills alongside its private files",
      { ...files, computerScope: "dedicated" as const },
      { ...base, computer: onVolumes },
      launch(
        [
          { volumeId: "vol_private_a", access: "rw" },
          { volumeId: "vol_shared_a", access: "rw" },
        ],
        {
          mode: "on_use",
          computerId: "computer_a",
        },
      ),
    ],
    [
      "a run without files or computer tools gets a worker with nothing mounted",
      { guestTools: false, computerTools: false, computerScope: "team" as const },
      { ...base, computer: { id: "computer_a", homeStorage: "snapshot" as const } },
      launch([], { mode: "none" }),
    ],
    [
      "a bot attached after its computer moved has no volume yet and is refused",
      { ...files, computerScope: "team" as const },
      { ...base, computer: onVolumes, privateVolumeId: null },
      { mode: "refused", refusal: { code: "slot_volume_missing", slot: "private" } },
    ],
  ])("%s", (_name, run, inputs, expected) => {
    expect(planLaunch(inputs, deriveRunNeeds(run))).toEqual(expected);
  });
});
