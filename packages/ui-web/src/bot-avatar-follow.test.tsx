// @vitest-environment jsdom
import { BotEngine } from "@tangow/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { BotAvatar, type BotAvatarProps } from "./bot-avatar.js";

const media = { reducedMotion: false, finePointer: true };

let container: HTMLElement;
let root: Root;
let setLook: MockInstance<BotEngine["setLook"]>;
let added: MockInstance;
let removed: MockInstance;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  media.reducedMotion = false;
  media.finePointer = true;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduce")
      ? media.reducedMotion
      : query.includes("fine") && media.finePointer,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(100, 100, 40, 40),
  );
  setLook = vi.spyOn(BotEngine.prototype, "setLook");
  added = vi.spyOn(window, "addEventListener");
  removed = vi.spyOn(window, "removeEventListener");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const render = (props: Partial<BotAvatarProps> = {}) =>
  act(() =>
    root.render(<BotAvatar color="#D9508A" identity="maya" variant="organic" {...props} />),
  );
const heard = (spy: MockInstance) => spy.mock.calls.some((call) => call[0] === "pointermove");
const listening = () => heard(added);
const move = (x: number, y: number) =>
  act(() => {
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y }));
  });
const looks = () => setLook.mock.calls.filter(([look]) => look !== null);

describe("BotAvatar followPointer", () => {
  it("looks where the pointer is, held to the head's range, from the avatar's own centre", () => {
    render({ followPointer: true });
    setLook.mockClear();

    move(5000, 120);
    move(-5000, -5000);
    move(120, 5000);

    expect(looks().map(([look]) => look)).toEqual([
      { yaw: 26, pitch: 0, mix: 1, spin: 0, wander: 0 },
      { yaw: -26, pitch: 18, mix: 1, spin: 0, wander: 0 },
      { yaw: 0, pitch: -8, mix: 1, spin: 0, wander: 0 },
    ]);
  });

  it("returns to the idle look when the pointer leaves the window", () => {
    render({ followPointer: true });
    move(5000, 120);
    setLook.mockClear();

    act(() => {
      document.documentElement.dispatchEvent(new MouseEvent("pointerleave"));
    });
    expect(setLook).toHaveBeenCalledTimes(1);
    expect(setLook.mock.calls[0]?.[0]).toBeNull();
  });

  it("registers nothing unless asked", () => {
    render();
    expect(listening()).toBe(false);
    move(5000, 120);
    expect(looks()).toEqual([]);
  });

  it("registers nothing under reduced motion", () => {
    media.reducedMotion = true;
    render({ followPointer: true });
    expect(listening()).toBe(false);
    move(5000, 120);
    expect(looks()).toEqual([]);
  });

  it("registers nothing for a touch screen", () => {
    media.finePointer = false;
    render({ followPointer: true });
    expect(listening()).toBe(false);
  });

  it("leaves the glances to a working bot, and picks the pointer up when it stops", () => {
    render({ followPointer: true, status: "running" });
    expect(listening()).toBe(false);

    render({ followPointer: true, status: "idle" });
    expect(listening()).toBe(true);
  });

  it("is ignored by the robot avatar", () => {
    render({ followPointer: true, variant: "robot" });
    expect(listening()).toBe(false);
  });

  it("stops listening when it unmounts", () => {
    render({ followPointer: true });
    act(() => root.unmount());
    expect(heard(removed)).toBe(true);
    setLook.mockClear();
    move(5000, 120);
    expect(looks()).toEqual([]);
    root = createRoot(container);
  });
});
