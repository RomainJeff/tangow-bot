import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { builtinAgentTools } from "./builtin-tools.js";
import {
  normalizeOpenAiToolParameters,
  openAiToolParametersNeedNormalization,
} from "./openai-tool-parameters.js";
import { parametersFor } from "./pi-runtime.js";

describe("normalizeOpenAiToolParameters", () => {
  it("fills properties for a zero-argument object schema", () => {
    expect(normalizeOpenAiToolParameters({ type: "object" })).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("keeps an empty properties map and does not invent parameters", () => {
    expect(normalizeOpenAiToolParameters({ type: "object", properties: {} })).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("forces type object when a union discriminator is missing", () => {
    const normalized = normalizeOpenAiToolParameters({
      anyOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
      ],
    });
    expect(normalized.type).toBe("object");
    expect(normalized.properties).toEqual({});
    expect(normalized.anyOf).toHaveLength(2);
  });

  it("preserves required, additionalProperties, and existing properties", () => {
    expect(
      normalizeOpenAiToolParameters({
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      }),
    ).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    });
  });

  it("replaces a non-object type with object without inventing fields", () => {
    expect(normalizeOpenAiToolParameters({ type: "string" })).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("treats nullish or non-object input as an empty object schema", () => {
    expect(normalizeOpenAiToolParameters(undefined)).toEqual({
      type: "object",
      properties: {},
    });
    expect(normalizeOpenAiToolParameters(null)).toEqual({
      type: "object",
      properties: {},
    });
    expect(normalizeOpenAiToolParameters([])).toEqual({
      type: "object",
      properties: {},
    });
  });
});

describe("openAiToolParametersNeedNormalization", () => {
  it("returns false for a complete object schema", () => {
    expect(openAiToolParametersNeedNormalization({ type: "object", properties: {} })).toBe(false);
  });

  it("returns true when type or properties are missing or malformed", () => {
    expect(openAiToolParametersNeedNormalization({ type: "object" })).toBe(true);
    expect(openAiToolParametersNeedNormalization({ anyOf: [] })).toBe(true);
    expect(openAiToolParametersNeedNormalization({ type: "object", properties: [] })).toBe(true);
    expect(openAiToolParametersNeedNormalization({ type: "string", properties: {} })).toBe(true);
  });
});

describe("parametersFor OpenAI wire fidelity", () => {
  it("serializes zero-argument tools with type object and empty properties", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "list_secrets");
    if (!tool) throw new Error("missing list_secrets");
    const wire = JSON.parse(JSON.stringify(parametersFor(tool))) as {
      type?: unknown;
      properties?: unknown;
    };
    expect(wire.type).toBe("object");
    expect(wire.properties).toEqual({});
  });

  it("serializes request_secret union with type object and empty properties", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "request_secret");
    if (!tool) throw new Error("missing request_secret");
    const wire = JSON.parse(JSON.stringify(parametersFor(tool))) as {
      type?: unknown;
      properties?: unknown;
      anyOf?: unknown[];
      oneOf?: unknown[];
    };
    expect(wire.type).toBe("object");
    expect(wire.properties).toEqual({});
    expect((wire.anyOf ?? wire.oneOf ?? []).length).toBe(2);
  });

  it("offers ask_user options as a label or an object, and checks them as the runtime does", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "ask_user");
    if (!tool) throw new Error("missing ask_user");
    const parameters = parametersFor(tool);
    const wire = JSON.parse(JSON.stringify(parameters));
    expect(wire.type).toBe("object");
    expect(wire.properties.questions.items.properties.options).toEqual({
      type: "array",
      minItems: 2,
      maxItems: 4,
      items: {
        anyOf: [
          { type: "string", minLength: 1, maxLength: 80 },
          {
            type: "object",
            properties: {
              label: { type: "string", minLength: 1, maxLength: 80 },
              description: { type: "string" },
              recommended: { type: "boolean" },
            },
            required: ["label"],
          },
        ],
      },
    });
    const check = (args: Record<string, unknown>) =>
      validateToolArguments(
        { name: "ask_user", description: "", parameters },
        { type: "toolCall", id: "call-1", name: "ask_user", arguments: args },
      );
    const described = {
      questions: [
        {
          question: "Which fridge?",
          options: ["Built-in", { label: "Freestanding", description: "Fits", recommended: true }],
        },
      ],
    };
    expect(check(described)).toEqual(described);
    expect(() =>
      check({ question: "Which fridge?", options: [{ label: "A" }, { label: "B" }] }),
    ).toThrow("options.0: must be string");
  });
});
