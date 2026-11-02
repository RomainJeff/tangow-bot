// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Read = { artifactId: string; settle: (ok: boolean) => void };
const reads: Read[] = [];

vi.mock("../../lib/rpc", () => ({
  rpc: {
    artifacts: {
      get: ({ artifactId }: { artifactId: string }) =>
        new Promise((resolve, reject) => {
          reads.push({
            artifactId,
            settle: (ok) =>
              ok
                ? resolve({ mimeType: "image/png", contentBase64: btoa(artifactId) })
                : reject(new Error("unreadable")),
          });
        }),
    },
  },
}));

import { useArtifactImageSrc } from "./use-artifact-image-src";

const shown: Record<string, { src: string | null; failed: boolean; retry: () => void }> = {};

function Picture({ id, slot }: { id: string; slot: string }) {
  const { container, src, failed, retry } = useArtifactImageSrc({ botId: "bot1" }, id);
  shown[slot] = { src, failed, retry };
  return <div ref={container} />;
}

let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  URL.createObjectURL = (blob) => `blob:${(blob as Blob).size}`;
  URL.revokeObjectURL = () => undefined;
  root = createRoot(document.createElement("div"));
});

const settleAll = (ok: boolean) =>
  act(async () => {
    for (const read of reads.splice(0)) read.settle(ok);
  });

afterEach(async () => {
  await settleAll(true);
  act(() => root.unmount());
});

describe("useArtifactImageSrc", () => {
  it("reads an artifact once for every place showing it, at most four at a time", async () => {
    const ids = ["a1", "a2", "a3", "a4", "a5", "a6"];
    act(() =>
      root.render(
        <>
          <Picture id="a1" slot="card" />
          <Picture id="a1" slot="viewer" />
          {ids.map((id) => (
            <Picture key={id} id={id} slot={id} />
          ))}
        </>,
      ),
    );
    expect(reads.map((read) => read.artifactId)).toEqual(["a1", "a2", "a3", "a4"]);

    await settleAll(true);
    expect(reads.map((read) => read.artifactId)).toEqual(["a5", "a6"]);
    expect(shown.card?.src).toMatch(/^blob:/);
    expect(shown.viewer?.src).toBe(shown.card?.src);
  });

  it("shows a failed read everywhere until a retry reads it again", async () => {
    act(() =>
      root.render(
        <>
          <Picture id="b1" slot="card" />
          <Picture id="b1" slot="viewer" />
        </>,
      ),
    );
    await settleAll(false);
    expect([shown.card?.failed, shown.viewer?.failed]).toEqual([true, true]);

    act(() => shown.viewer?.retry());
    expect(reads.map((read) => read.artifactId)).toEqual(["b1"]);
    await settleAll(true);
    expect([shown.card?.failed, shown.viewer?.failed]).toEqual([false, false]);
    expect(shown.card?.src).toMatch(/^blob:/);
  });
});
