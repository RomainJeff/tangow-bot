import { describe, expect, it } from "vitest";
import { appConnectPresentation } from "./app-connect.js";

describe("appConnectPresentation", () => {
  const block = {
    kind: "app_connect" as const,
    provider: "gmail",
    name: "Gmail",
    description: "Search, read, draft, and send email.",
    logo: null,
    status: "pending" as const,
  };

  it("renders an authorize control for pending app_connect blocks", () => {
    const view = appConnectPresentation(block);
    expect(view.showAuthorize).toBe(true);
    expect(view.actionLabel).toBe("Authorize");
  });

  it("offers no authorize control for an MCP server a shared bot needs", () => {
    const view = appConnectPresentation({ ...block, connectorId: "mcp", provider: "server-1" });
    expect(view.showAuthorize).toBe(false);
    expect(view.connected).toBe(false);
  });

  it("hides authorize once connected", () => {
    const view = appConnectPresentation({ ...block, status: "connected" });
    expect(view.showAuthorize).toBe(false);
    expect(view.actionLabel).toBe("Connected");
  });
});
