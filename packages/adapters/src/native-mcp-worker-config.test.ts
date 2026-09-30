import { describe, expect, it } from "vitest";
import { nativeMcpMountConfig } from "./native-mcp-worker-config.js";

describe("nativeMcpMountConfig", () => {
  it("mounts only when both the port and relay secret are configured", () => {
    expect(nativeMcpMountConfig({})).toBeUndefined();
    expect(nativeMcpMountConfig({ RAKAZO_NATIVE_MCP_PORT: "7300" })).toBeUndefined();
    expect(nativeMcpMountConfig({ RAKAZO_NATIVE_MCP_RELAY_SECRET: "relay" })).toBeUndefined();
    expect(
      nativeMcpMountConfig({
        RAKAZO_NATIVE_MCP_PORT: "7300",
        RAKAZO_NATIVE_MCP_RELAY_SECRET: "relay",
      }),
    ).toEqual({ port: 7300, relaySecret: "relay", host: "worker" });
  });
});
