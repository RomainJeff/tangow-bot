/** Stable in-network endpoint for a Computer's native MCP relay. */
export const NATIVE_MCP_NETWORK_ALIAS = "rakazo-mcp";
export const NATIVE_MCP_RELAY_PORT = 7091;
export const NATIVE_MCP_RELAY_URL = `http://${NATIVE_MCP_NETWORK_ALIAS}:${NATIVE_MCP_RELAY_PORT}/native-mcp`;

export const nativeMcpRelayHeaders = {
  relaySecret: "x-rakazo-relay-secret",
  sourceComputer: "x-rakazo-source-computer",
} as const;
