import { describe, expect, it } from "vitest";
import { addressHoldsSecret } from "./declared-mcp.js";

describe("an MCP server whose address may hold a secret", () => {
  const remote = (endpoint: string) => ({ transport: "streamable_http", endpoint, args: [] });
  const stdio = (...args: string[]) => ({ transport: "stdio", endpoint: null, args });

  it.each([
    ["a query string", remote("https://mcp.example.test/mcp?key=abc"), true],
    ["user info", remote("https://user:pass@mcp.example.test/mcp"), true],
    ["a clean endpoint", remote("https://mcp.example.test/mcp"), false],
    ["--token=value", stdio("--token=abc"), true],
    ["--api_key then a value", stdio("--api_key", "abc"), true],
    ["--API-KEY=value", stdio("--API-KEY=abc"), true],
    ["--apikey=value", stdio("--apikey=abc"), true],
    ["--key then a value", stdio("--stdio", "--key", "abc"), true],
    ["--secret=value", stdio("--secret=abc"), true],
    ["--password then a value", stdio("--password", "abc"), true],
    ["flags that only start like one", stdio("--stdio", "--keyboard", "--tokens-dir=/tmp"), false],
  ])("%s", (_name, server, holds) => {
    expect(addressHoldsSecret(server)).toBe(holds);
  });
});
