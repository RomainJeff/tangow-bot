import { describe, expect, it } from "vitest";
import type { VolumeRow } from "./worker-plan.js";
import { authorizeMounts, volumeMountPath } from "./worker-plan.js";

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
