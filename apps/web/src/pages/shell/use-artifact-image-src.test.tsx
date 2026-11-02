// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Outcome = "read" | "unreadable" | "undecodable";
type Read = { artifactId: string; settle: (outcome: Outcome) => void };
const reads: Read[] = [];

vi.mock("../../lib/rpc", () => ({
  rpc: {
    artifacts: {
      get: ({ artifactId }: { artifactId: string }) =>
        new Promise((resolve, reject) => {
          reads.push({
            artifactId,
            settle: (outcome) =>
              outcome === "unreadable"
                ? reject(new Error("unreadable"))
                : resolve({
                    mimeType: "image/png",
                    contentBase64: outcome === "read" ? btoa(artifactId) : "not base64!",
                  }),
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

const settleAll = (outcome: Outcome) =>
  act(async () => {
    for (const read of reads.splice(0)) read.settle(outcome);
  });

afterEach(async () => {
  await settleAll("read");
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

    await settleAll("read");
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
    await settleAll("unreadable");
    expect([shown.card?.failed, shown.viewer?.failed]).toEqual([true, true]);

    act(() => shown.viewer?.retry());
    expect(reads.map((read) => read.artifactId)).toEqual(["b1"]);
    await settleAll("read");
    expect([shown.card?.failed, shown.viewer?.failed]).toEqual([false, false]);
    expect(shown.card?.src).toMatch(/^blob:/);
  });

  it("shows a picture whose bytes cannot be decoded as failed until a retry reads it again", async () => {
    act(() => root.render(<Picture id="c1" slot="card" />));
    await settleAll("undecodable");
    expect(shown.card?.failed).toBe(true);

    act(() => shown.card?.retry());
    expect(reads.map((read) => read.artifactId)).toEqual(["c1"]);
    await settleAll("read");
    expect(shown.card?.src).toMatch(/^blob:/);
  });

  it("skips a queued read once nothing shows its picture, and reads it when shown again", async () => {
    const ids = ["d1", "d2", "d3", "d4", "d5"];
    act(() => root.render(ids.map((id) => <Picture key={id} id={id} slot={id} />)));
    act(() => root.render(ids.slice(0, 4).map((id) => <Picture key={id} id={id} slot={id} />)));
    await settleAll("read");
    expect(reads).toEqual([]);

    act(() => root.render(<Picture id="d5" slot="d5" />));
    expect(reads.map((read) => read.artifactId)).toEqual(["d5"]);
  });
});
