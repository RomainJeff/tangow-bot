import { describe, expect, it } from "vitest";
import { ThreadScrollBehavior } from "./thread-scroll.js";

describe("mobile thread initial scroll", () => {
  it("waits for layout when messages arrive first, then opens at the latest message", () => {
    const behavior = new ThreadScrollBehavior();
    behavior.openThread("thread-1");

    expect(behavior.onContentChanged(false, "m1")).toBe(null);
    expect(behavior.onLayout()).toBe("jump");
  });

  it("opens at the latest message when layout arrives before content", () => {
    const behavior = new ThreadScrollBehavior();
    behavior.openThread("thread-1");

    expect(behavior.onLayout()).toBe(null);
    expect(behavior.onContentChanged(false, "m1")).toBe("jump");
  });

  it("does not move for expanded labels but smoothly follows a new message", () => {
    const behavior = new ThreadScrollBehavior();
    behavior.openThread("thread-1");
    behavior.onLayout();

    expect(behavior.onContentChanged(false, "m1")).toBe("jump");
    expect(behavior.onContentChanged(false, "m1")).toBe(null);
    expect(behavior.onContentChanged(false, "m2")).toBe("smooth");
  });

  it("keeps the latest message visible when the viewport resizes", () => {
    const behavior = new ThreadScrollBehavior();
    behavior.openThread("thread-1");
    behavior.onContentChanged(false, "m1");

    expect(behavior.onLayout()).toBe("jump");
    expect(behavior.onLayout()).toBe("jump");
  });

  it("keeps the initial jump pending while another scroll target blocks it", () => {
    const behavior = new ThreadScrollBehavior();
    behavior.openThread("thread-1");

    expect(behavior.onContentChanged(true, "m1")).toBe(null);
    expect(behavior.onLayout()).toBe(null);
    expect(behavior.onContentChanged(false, "m1")).toBe("jump");
    expect(behavior.onContentChanged(false, "m1")).toBe(null);
  });

  it("leaves a detached reader in place and records unread messages", () => {
    const behavior = new ThreadScrollBehavior();
    behavior.openThread("thread-1");
    behavior.onLayout();
    behavior.onContentChanged(false, "m1");

    expect(behavior.onUserScroll(120)).toEqual({ detached: true, unread: false });
    expect(behavior.onLayout()).toBe(null);
    expect(behavior.onContentChanged(false, "m2")).toBe(null);
    expect(behavior.state()).toEqual({ detached: true, unread: true });
    expect(behavior.jumpToLatest()).toBe("smooth");
    expect(behavior.state()).toEqual({ detached: false, unread: false });
  });
});

describe("mobile thread scroll state identity", () => {
  it("keeps the same state object while scrolling does not change it", () => {
    const behavior = new ThreadScrollBehavior();
    behavior.openThread("thread-1");
    const attached = behavior.state();

    expect(behavior.onUserScroll(10)).toBe(attached);
    expect(behavior.onUserScroll(40)).toBe(attached);

    const detached = behavior.onUserScroll(200);
    expect(detached).not.toBe(attached);
    expect(behavior.onUserScroll(400)).toBe(detached);
  });
});
