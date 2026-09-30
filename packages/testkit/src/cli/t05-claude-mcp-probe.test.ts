import { describe, expect, it } from "vitest";
import { relayReport } from "./t05-claude-mcp-probe.mjs";

describe("Claude MCP probe report", () => {
  it("reports recorded methods and comparisons without needing CLI output", () => {
    expect(relayReport('{"method":"initialize","bearer":"expected"}\n')).toEqual([
      "MCP_REQUEST method=initialize match=true",
      "J3D2_CLAUDE_MCP_METHODS=initialize",
      "J3D2_CLAUDE_MCP_BEARER=yes",
    ]);
  });
  it("does not claim proof from an empty recording or a mismatching request", () => {
    expect(relayReport("")).toContain("J3D2_CLAUDE_MCP_BEARER=no");
    expect(relayReport('{"method":"initialize","bearer":"unexpected"}\n')).toContain(
      "J3D2_CLAUDE_MCP_BEARER=no",
    );
    expect(relayReport('{"method":null,"bearer":"expected"}\n')).toContain(
      "J3D2_CLAUDE_MCP_BEARER=no",
    );
  });
});
