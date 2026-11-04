import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { decodeArtifactBase64 } from "../../lib/artifact-open";
import { rpc } from "../../lib/rpc";

type ImageEntry = { status: "loading" } | { status: "ready"; url: string } | { status: "failed" };

/** Reads at once: each is a whole file sent as base64, and the server answers a burst slower. */
const MAX_IN_FLIGHT = 4;
/** Pictures kept once nothing shows them, so scrolling back or reopening the viewer reads none again. */
const KEPT = 64;

/** One read per artifact for the page's life, whoever shows it. Least recently asked for first. */
const entries = new Map<string, ImageEntry>();
const listeners = new Map<string, Set<() => void>>();
const waiting: { artifactId: string; read: () => Promise<void> }[] = [];
let inFlight = 0;

function settle(artifactId: string, entry: ImageEntry | undefined) {
  const previous = entries.get(artifactId);
  if (previous?.status === "ready") URL.revokeObjectURL(previous.url);
  entries.delete(artifactId);
  if (entry) entries.set(artifactId, entry);
  for (const listener of listeners.get(artifactId) ?? []) listener();
}

function evictUnseen() {
  for (const [artifactId, entry] of entries) {
    if (entries.size <= KEPT) return;
    if (entry.status !== "loading" && !listeners.has(artifactId)) settle(artifactId, undefined);
  }
}

function drain() {
  while (inFlight < MAX_IN_FLIGHT && waiting.length > 0) {
    const { artifactId, read } = waiting.shift()!;
    // Nothing shows it any more: drop it so what is on screen goes first, and a later mount asks again.
    if (!listeners.has(artifactId)) {
      entries.delete(artifactId);
      continue;
    }
    inFlight += 1;
    void read().finally(() => {
      inFlight -= 1;
      drain();
    });
  }
}

function load(target: ArtifactTarget, artifactId: string) {
  const current = entries.get(artifactId);
  if (current) {
    entries.delete(artifactId);
    entries.set(artifactId, current);
    return;
  }
  settle(artifactId, { status: "loading" });
  waiting.push({
    artifactId,
    read: () =>
      rpc.artifacts
        .get({ ...target, artifactId })
        .then((artifact) => {
          const bytes = decodeArtifactBase64(artifact.contentBase64);
          const blob = new Blob([new Uint8Array(bytes)], { type: artifact.mimeType });
          settle(artifactId, { status: "ready", url: URL.createObjectURL(blob) });
        })
        .catch(() => settle(artifactId, { status: "failed" })),
  });
  evictUnseen();
  drain();
}

/** What is known of an artifact's picture, without asking for it. */
export function useArtifactImage(artifactId: string): ImageEntry | undefined {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const set = listeners.get(artifactId) ?? new Set();
      listeners.set(artifactId, set);
      set.add(onChange);
      return () => {
        set.delete(onChange);
        if (set.size > 0) return;
        listeners.delete(artifactId);
        // A failure holds only while shown: the next place to show it reads again.
        if (entries.get(artifactId)?.status === "failed") entries.delete(artifactId);
      };
    },
    [artifactId],
  );
  return useSyncExternalStore(subscribe, () => entries.get(artifactId));
}

/**
 * An image artifact of the thread as an object URL, read once its container nears the viewport and
 * shared by every place that shows it. `failed` turns true when the artifact cannot be read, or
 * when an image given `onImageError` cannot decode it, so a caller can draw its fallback; `retry`
 * reads it again. While `enabled` is false nothing is read, though a picture already read shows.
 */
export function useArtifactImageSrc<Container extends HTMLElement = HTMLDivElement>(
  target: ArtifactTarget,
  artifactId: string,
  enabled = true,
) {
  const [visible, setVisible] = useState(false);
  const container = useRef<Container>(null);
  const entry = useArtifactImage(artifactId);
  const targetBotId = "botId" in target ? target.botId : undefined;
  const targetGroupId = "groupId" in target ? target.groupId : undefined;

  useEffect(() => {
    const element = container.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed.some((item) => item.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !enabled) return;
    load(targetBotId ? { botId: targetBotId } : { groupId: targetGroupId ?? "" }, artifactId);
  }, [artifactId, targetBotId, targetGroupId, visible, enabled]);

  return {
    container,
    src: entry?.status === "ready" ? entry.url : null,
    failed: entry?.status === "failed",
    onImageError: () => settle(artifactId, { status: "failed" }),
    retry: () => {
      if (entries.get(artifactId)?.status !== "failed") return;
      entries.delete(artifactId);
      load(target, artifactId);
    },
  };
}
