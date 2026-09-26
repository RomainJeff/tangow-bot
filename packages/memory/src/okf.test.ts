import { describe, expect, it } from "vitest";
import { OKF_TOLARIA_PROFILE, parseOkfDocument, serializeOkfDocument } from "./okf.js";

describe("OKF Tolaria portability", () => {
  it("preserves Markdown exactly and serializes profile data stably", () => {
    const content = "\n# A decision\n\n- Keep the exception\n  - until review\n";
    const markdown = serializeOkfDocument({
      profileVersion: OKF_TOLARIA_PROFILE,
      documentType: "Note",
      nature: "decision",
      entityRefs: [{ kind: "project", documentId: "project-123" }],
      relations: [{ documentId: "memory-456", relation: "related" }],
      content,
      unknownMetadata: { objective: { label: "Legacy objective", keyResult: "Legacy KR" } },
    });
    const parsed = parseOkfDocument(markdown);
    expect(parsed.content).toBe(content);
    expect(parsed.documentType).toBe("Note");
    expect(parsed.nature).toBe("decision");
    expect(parsed.entityRefs).toEqual([{ kind: "project", documentId: "project-123" }]);
    expect(parsed.unknownMetadata?.objective).toEqual({
      label: "Legacy objective",
      keyResult: "Legacy KR",
    });
    expect(serializeOkfDocument(parsed)).toBe(markdown);
  });

  it("keeps imported authority claims inert in an extensions namespace", () => {
    const imported = [
      "---",
      "type: Note",
      "profile: okf-tolaria/0.1",
      "status: active",
      "author: trusted-admin",
      "verified: true",
      "permissions:",
      "  - publish",
      "---",
      "# Untrusted import",
      "",
    ].join("\n");
    const parsed = parseOkfDocument(imported);
    expect(parsed).not.toHaveProperty("status");
    expect(parsed).not.toHaveProperty("author");
    expect(parsed.unknownMetadata).toEqual({
      status: "active",
      author: "trusted-admin",
      verified: true,
      permissions: ["publish"],
    });
    const exported = serializeOkfDocument(parsed);
    expect(exported).toContain("extensions:");
    expect(exported).not.toMatch(/^status:/m);
    expect(exported).not.toMatch(/^author:/m);
    expect(parseOkfDocument(exported).unknownMetadata).toEqual(parsed.unknownMetadata);
  });

  it("accepts standard OKF documents without a Tolaria profile marker and tags exports", () => {
    const imported = parseOkfDocument("---\ntype: Note\n---\n# Portable\n");
    expect(imported.profileVersion).toBe(OKF_TOLARIA_PROFILE);
    expect(imported.content).toBe("# Portable\n");
    expect(serializeOkfDocument(imported)).toContain("profile: okf-tolaria/0.1");
  });

  it("retains prototype-shaped unknown keys as inert own properties", () => {
    const imported = [
      "---",
      "type: Note",
      "profile: okf-tolaria/0.1",
      "extensions:",
      "  __proto__:",
      "    polluted: true",
      "  constructor: keep-me",
      "  prototype: also-keep-me",
      "---",
      "body",
    ].join("\n");
    const parsed = parseOkfDocument(imported);
    expect(Object.hasOwn(parsed.unknownMetadata ?? {}, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(parsed.unknownMetadata, "__proto__")?.value).toEqual({
      polluted: true,
    });
    expect(Object.getPrototypeOf(parsed.unknownMetadata)).toBeNull();
    const reimported = parseOkfDocument(serializeOkfDocument(parsed));
    expect(reimported.unknownMetadata).toEqual(parsed.unknownMetadata);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects alias expansion and ambiguous duplicate unknown fields instead of dropping metadata", () => {
    expect(() =>
      parseOkfDocument(
        "---\ntype: Note\nprofile: okf-tolaria/0.1\nextensions: &x { nested: yes }\nother: *x\n---\nbody",
      ),
    ).toThrow();
    expect(() =>
      parseOkfDocument(
        "---\ntype: Note\nprofile: okf-tolaria/0.1\nstatus: active\nextensions:\n  status: archived\n---\nbody",
      ),
    ).toThrow(/Duplicate unknown OKF metadata field/);
  });

  it("rejects missing type, unsupported profile, malformed YAML, and reserved extension collisions", () => {
    expect(() => parseOkfDocument("---\nprofile: okf-tolaria/0.1\n---\nbody")).toThrow(
      /type is required/,
    );
    expect(() => parseOkfDocument("---\ntype: Note\nprofile: okf-tolaria/9\n---\nbody")).toThrow(
      /Unsupported OKF profile/,
    );
    expect(() =>
      parseOkfDocument("---\ntype: Note\ntype: Project\nprofile: okf-tolaria/0.1\n---\nbody"),
    ).toThrow(/Invalid OKF YAML/);
    expect(() =>
      serializeOkfDocument({
        profileVersion: OKF_TOLARIA_PROFILE,
        documentType: "Note",
        content: "body",
        unknownMetadata: { type: "Project" },
      }),
    ).toThrow(/reserved key/);
  });
});
