import { describe, expect, it } from "vitest";
import { cn } from "./utils.js";

describe("cn", () => {
  it("lets a Quiet type step override the stock font size", () => {
    expect(cn("text-sm font-medium", "text-capsule")).toBe("font-medium text-capsule");
    expect(cn("text-sm", "text-body")).toBe("text-body");
  });

  it("keeps a type step and a colour apart", () => {
    expect(cn("text-body text-muted-foreground")).toBe("text-body text-muted-foreground");
  });

  it("lets a Quiet radius, shadow and size override the stock scale", () => {
    expect(cn("rounded-lg", "rounded-block")).toBe("rounded-block");
    expect(cn("rounded-block", "rounded-full")).toBe("rounded-full");
    expect(cn("shadow-sm", "shadow-card")).toBe("shadow-card");
    expect(cn("size-8", "size-composer-icon")).toBe("size-composer-icon");
    expect(cn("h-9", "h-capsule")).toBe("h-capsule");
  });

  it("keeps the selected ring's width apart from its colour", () => {
    expect(
      cn(
        "focus-visible:ring-3 focus-visible:ring-ring/50",
        "focus-visible:ring-selected focus-visible:ring-foreground",
      ),
    ).toBe("focus-visible:ring-selected focus-visible:ring-foreground");
  });
});
