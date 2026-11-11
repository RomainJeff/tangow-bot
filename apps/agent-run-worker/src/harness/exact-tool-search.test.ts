import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { createToolSearchExtension } from "@earendil-works/pi-coding-agent";
import { TANGOW_TOOL_PREFIX } from "@tangow/adapter-kit";
import { expect, it } from "vitest";
import { exactToolSearchExtension } from "./exact-tool-search.js";

const send = `${TANGOW_TOOL_PREFIX}GMAIL_SEND_EMAIL`;
const fetch = `${TANGOW_TOOL_PREFIX}GMAIL_FETCH_EMAILS`;

function candidate(name: string, description: string, exposure: ToolInfo["exposure"]): ToolInfo {
  return {
    name,
    description,
    exposure,
    parameters: { type: "object", properties: {} },
    sourceInfo: { source: "extension", path: "fixture", scope: "temporary", origin: "top-level" },
  };
}

const tools = [
  candidate(send, "Send an email.\nFurther details.", "deferred"),
  candidate(fetch, "Fetch emails from the inbox.", "codemode"),
  candidate(`${TANGOW_TOOL_PREFIX}GMAIL_REPLY_TO_THREAD`, "Send an email reply.", "deferred"),
  candidate("direct_tool", "Send an email directly.", "direct"),
  candidate("model_tool", "Fetch emails for the model.", "model-only"),
];

async function searchExtension(factory: ExtensionFactory, initialActive = ["tool_search"]) {
  let active = [...initialActive];
  const registered: ToolDefinition[] = [];
  const api = {
    getAllTools: () => tools,
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    registerTool: (tool: ToolDefinition) => registered.push(tool),
  } as unknown as ExtensionAPI;
  await factory(api);
  expect(registered.map((tool) => tool.name)).toEqual(["tool_search"]);
  const tool = registered[0]!;
  return {
    active: () => active,
    search: (query: string, limit?: number) =>
      tool.execute("call", { query, limit }, undefined, undefined, undefined as never),
  };
}

it.each([
  { query: "GMAIL_SEND_EMAIL", names: [send] },
  { query: send, names: [send] },
  { query: "GMAIL_SEND_EMAIL, GMAIL_FETCH_EMAILS", names: [send, fetch] },
  { query: `${send},${fetch}`, names: [send, fetch] },
  { query: `  GMAIL_SEND_EMAIL\n${fetch}\tGMAIL_SEND_EMAIL, `, names: [send, fetch] },
])("loads only the exact names in $query", async ({ query, names }) => {
  const extension = await searchExtension(exactToolSearchExtension());
  const result = await extension.search(query, names.length > 1 ? 1 : undefined);

  expect(result.details).toEqual({ loaded: names });
  expect(result.content).toEqual([
    {
      type: "text",
      text:
        names.length === 1
          ? `Loaded 1 tool. They are available from your next call:\n- ${send}: Send an email.`
          : `Loaded 2 tools. They are available from your next call:\n- ${send}: Send an email.\n- ${fetch}: Fetch emails from the inbox.`,
    },
  ]);
  expect(extension.active()).toEqual(["tool_search", ...names]);
});

it.each(["send an email", "GMAIL_SEND_EMAIL inbox", "direct_tool", "model_tool", ", ,"])(
  "preserves pi's search results and activation for %s",
  async (query) => {
    const wrapped = await searchExtension(exactToolSearchExtension());
    const original = await searchExtension(createToolSearchExtension());

    expect(await wrapped.search(query)).toEqual(await original.search(query));
    expect(wrapped.active()).toEqual(original.active());
  },
);

it("keeps active exact names available and loads only the remaining names", async () => {
  const wrapped = await searchExtension(exactToolSearchExtension(), ["tool_search", send]);

  expect(await wrapped.search("GMAIL_SEND_EMAIL")).toEqual({
    content: [{ type: "text", text: "The requested tools are already available." }],
    details: { loaded: [] },
  });
  expect(wrapped.active()).toEqual(["tool_search", send]);
  expect((await wrapped.search("GMAIL_SEND_EMAIL, GMAIL_FETCH_EMAILS")).details).toEqual({
    loaded: [fetch],
  });
  expect(wrapped.active()).toEqual(["tool_search", send, fetch]);
});
