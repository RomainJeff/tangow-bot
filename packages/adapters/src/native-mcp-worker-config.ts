/** Worker startup is fail-closed: without both values no HTTP listener exists. */
export function nativeMcpMountConfig(env: {
  RAKAZO_NATIVE_MCP_PORT?: string;
  RAKAZO_NATIVE_MCP_RELAY_SECRET?: string;
  RAKAZO_NATIVE_MCP_HOST?: string;
}): { port: number; relaySecret: string; host: string } | undefined {
  const port = env.RAKAZO_NATIVE_MCP_PORT;
  const relaySecret = env.RAKAZO_NATIVE_MCP_RELAY_SECRET;
  if (!port || !relaySecret) return undefined;

  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535)
    throw new Error("RAKAZO_NATIVE_MCP_PORT must be a valid TCP port");
  const host = env.RAKAZO_NATIVE_MCP_HOST?.trim() || "worker";
  if (host === "0.0.0.0" || host === "::")
    throw new Error("RAKAZO_NATIVE_MCP_HOST must not bind every interface");
  return { port: parsedPort, relaySecret, host };
}
