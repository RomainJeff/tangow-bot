import type { ThreadView } from "@tangow/core";
import type { HTMLAttributes, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  transcriptEnd,
  transcriptIsNearEnd,
  transcriptMovedDown,
} from "../../lib/transcript-scroll";

/** How long a jump to a message holds off following the end while its smooth scroll gets going. */
const JUMP_SETTLE_MS = 1500;

export function useTranscriptFollow({
  scrollRef,
  followingRef,
  rows,
  running,
  rowOf,
  onLoadOlder,
  onJumpToMessage,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  followingRef: RefObject<boolean>;
  rows: ThreadView["rows"];
  running: boolean;
  rowOf: ThreadView["rowOf"];
  onLoadOlder: () => void | Promise<void>;
  onJumpToMessage: (messageId: string) => void;
}) {
  const [atEnd, setAtEnd] = useState(true);
  const following = followingRef;
  const mounted = useRef(false);
  if (!mounted.current) {
    mounted.current = true;
    following.current = true;
  }
  const autoScrolling = useRef(false);
  const jumpedAt = useRef(Number.NEGATIVE_INFINITY);
  const jumpSettleTimer = useRef<number | undefined>(undefined);
  const lastScrollTop = useRef<number | null>(null);
  const press = useRef<{ top: number; following: boolean } | null>(null);
  const autoScrollTimer = useRef<number | undefined>(undefined);

  // A jump the person asked for leaves the end, so the next streamed row must not pull back.
  const jumpToMessage = useCallback(
    (messageId: string) => {
      following.current = false;
      jumpedAt.current = performance.now();
      onJumpToMessage(messageId);
      window.clearTimeout(jumpSettleTimer.current);
      // A jump to a row already on the last screen never scrolls down: follow again once it settles there.
      jumpSettleTimer.current = window.setTimeout(() => {
        const element = scrollRef.current;
        if (!element) return;
        const nearEnd = transcriptIsNearEnd(element);
        setAtEnd(nearEnd);
        const rowId = rowOf.get(messageId) ?? messageId;
        if (nearEnd && element.querySelector(`[data-message-id="${CSS.escape(rowId)}"]`)) {
          following.current = true;
        }
      }, JUMP_SETTLE_MS);
    },
    [onJumpToMessage, rowOf, scrollRef],
  );

  const snapToEnd = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    following.current = true;
    autoScrolling.current = false;
    setAtEnd(true);
    element.scrollTo({ top: transcriptEnd(element), behavior: "auto" });
  }, [scrollRef]);

  const jumpToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    following.current = true;
    autoScrolling.current = !reducedMotion;
    setAtEnd(true);
    element.scrollTo({
      top: element.scrollHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    });
    window.clearTimeout(autoScrollTimer.current);
    // Fallback only: onScroll clears autoScrolling once near-end is reached.
    autoScrollTimer.current = window.setTimeout(
      () => {
        autoScrolling.current = false;
      },
      reducedMotion ? 0 : 2_000,
    );
  }, [scrollRef]);

  useLayoutEffect(() => {
    if (following.current) snapToEnd();
  }, [rows, running, snapToEnd]);

  // A taller draft, or a notice or reply chip that stops the thread above the
  // composer, shortens the thread without a new row: keep its end in view.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following.current && !autoScrolling.current) snapToEnd();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRef, snapToEnd]);

  const loadOlder = useCallback(() => {
    const wasFollowing = following.current;
    // Prepend must not race the messages-driven snap-to-end follow path.
    following.current = false;
    autoScrolling.current = false;
    const pending = onLoadOlder();
    if (!pending) return;
    return Promise.resolve(pending).catch((error) => {
      const element = scrollRef.current;
      if (wasFollowing && element && transcriptIsNearEnd(element)) {
        following.current = true;
        setAtEnd(true);
      }
      throw error;
    });
  }, [onLoadOlder, scrollRef]);

  useEffect(
    () => () => {
      window.clearTimeout(autoScrollTimer.current);
      window.clearTimeout(jumpSettleTimer.current);
    },
    [],
  );

  const scrollerHandlers: HTMLAttributes<HTMLDivElement> = {
    onPointerDown: (event) => {
      press.current = { top: event.currentTarget.scrollTop, following: following.current };
      lastScrollTop.current = event.currentTarget.scrollTop;
      autoScrolling.current = false;
      following.current = false;
    },
    onPointerUp: (event) => {
      // A press that left the list where it was is a tap on a row (a card's choice), not a
      // hand on the scroll: the view keeps following the end it followed.
      if (press.current?.following && event.currentTarget.scrollTop === press.current.top) {
        following.current = true;
      }
      press.current = null;
    },
    onTouchStart: (event) => {
      lastScrollTop.current = event.currentTarget.scrollTop;
      autoScrolling.current = false;
      following.current = false;
    },
    onWheel: (event) => {
      if (event.deltaY < 0) {
        lastScrollTop.current = event.currentTarget.scrollTop;
        autoScrolling.current = false;
        following.current = false;
      }
    },
    onScroll: (event) => {
      const scrolledDown = transcriptMovedDown(
        lastScrollTop.current,
        event.currentTarget.scrollTop,
      );
      lastScrollTop.current = event.currentTarget.scrollTop;
      const nearEnd = transcriptIsNearEnd(event.currentTarget);
      setAtEnd(nearEnd);
      if (nearEnd) {
        // While a jump's smooth scroll starts, a row landing at the end must not resume following.
        if (scrolledDown && performance.now() - jumpedAt.current > JUMP_SETTLE_MS) {
          following.current = true;
        }
        if (autoScrolling.current) {
          autoScrolling.current = false;
          window.clearTimeout(autoScrollTimer.current);
        }
      } else if (!autoScrolling.current) {
        following.current = false;
      }
    },
  };

  return { atEnd, jumpToMessage, jumpToLatest, loadOlder, scrollerHandlers };
}
