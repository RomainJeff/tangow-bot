import type { MemoryQualification } from "@rakazo/contracts";
import { parseDocument, stringify } from "yaml";

type MemoryEntityKind = NonNullable<MemoryQualification["entityRefs"]>[number]["kind"];
type MemoryNature = NonNullable<MemoryQualification["nature"]>;

export const OKF_TOLARIA_PROFILE = "okf-tolaria/0.1" as const;
export const OKF_MAX_MARKDOWN_LENGTH = 1_000_000;

export type OkfEntityReference = { kind: MemoryEntityKind; documentId: string };

export type OkfDocument = {
  profileVersion: typeof OKF_TOLARIA_PROFILE;
  documentType: string;
  nature?: MemoryNature;
  entityRefs?: OkfEntityReference[];
  relations?: Array<{
    documentId: string;
    relation: "duplicate" | "complement" | "contradiction" | "possible_replacement" | "related";
  }>;
  /** Markdown payload is retained exactly, including its trailing newline. */
  content: string;
  /** Unknown imported fields are inert extension values, never canonical authority. */
  unknownMetadata?: Record<string, unknown>;
};

const NATURES = new Set<MemoryNature>([
  "decision",
  "preference",
  "observation",
  "procedure",
  "hypothesis",
]);
const ENTITY_KINDS = new Set<MemoryEntityKind>(["project", "responsibility", "topic", "person"]);
const RELATIONS = new Set<NonNullable<OkfDocument["relations"]>[number]["relation"]>([
  "duplicate",
  "complement",
  "contradiction",
  "possible_replacement",
  "related",
]);
const ROOT_RESERVED_KEYS = new Set([
  "type",
  "profile",
  "nature",
  "entityRefs",
  "relations",
  "extensions",
]);

/** Parse the Tolaria OKF profile without treating imported authority fields as trusted. */
export function parseOkfDocument(markdown: string): OkfDocument {
  if (markdown.length > OKF_MAX_MARKDOWN_LENGTH)
    throw new Error("OKF document exceeds the import size limit");
  const opening = markdown.match(/^---\r?\n/);
  if (!opening) throw new Error("OKF front matter is required");
  const delimiter = /\r?\n---(?:\r?\n|$)/g;
  delimiter.lastIndex = opening[0].length;
  const closing = delimiter.exec(markdown);
  if (!closing) throw new Error("OKF front matter is not closed");
  const yamlSource = markdown.slice(opening[0].length, closing.index);
  const document = parseDocument(yamlSource, { uniqueKeys: true });
  if (document.errors.length > 0)
    throw new Error(`Invalid OKF YAML: ${document.errors[0]?.message ?? "parse error"}`);
  const parsed = document.toJS({ maxAliasCount: 0 });
  if (!isRecord(parsed)) throw new Error("OKF metadata must be a YAML mapping");
  if (
    typeof parsed.type !== "string" ||
    parsed.type.trim().length === 0 ||
    parsed.type.trim().length > 120
  )
    throw new Error("OKF type is required");
  if (parsed.profile !== undefined && parsed.profile !== OKF_TOLARIA_PROFILE)
    throw new Error(`Unsupported OKF profile; expected ${OKF_TOLARIA_PROFILE}`);
  if (parsed.nature !== undefined && !isNature(parsed.nature))
    throw new Error("Invalid OKF nature");
  const entityRefs =
    parsed.entityRefs === undefined ? undefined : parseEntityRefs(parsed.entityRefs);
  const relations = parsed.relations === undefined ? undefined : parseRelations(parsed.relations);
  if (parsed.extensions !== undefined && !isRecord(parsed.extensions))
    throw new Error("OKF extensions must be a YAML mapping");
  const unknownMetadata = Object.create(null) as Record<string, unknown>;
  const extensions = (parsed.extensions ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(extensions))
    Object.defineProperty(unknownMetadata, key, {
      value: normalizeUnknownValue(value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  for (const [key, value] of Object.entries(parsed)) {
    if (!ROOT_RESERVED_KEYS.has(key)) {
      if (Object.hasOwn(unknownMetadata, key))
        throw new Error(`Duplicate unknown OKF metadata field: ${key}`);
      Object.defineProperty(unknownMetadata, key, {
        value: normalizeUnknownValue(value),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  const contentStart = closing.index + closing[0].length;
  const content = markdown.slice(contentStart);
  return {
    profileVersion: OKF_TOLARIA_PROFILE,
    documentType: parsed.type.trim(),
    ...(parsed.nature ? { nature: parsed.nature } : {}),
    ...(entityRefs ? { entityRefs } : {}),
    ...(relations ? { relations } : {}),
    content,
    ...(Object.keys(unknownMetadata).length ? { unknownMetadata } : {}),
  };
}

/** Serialize profile data; imported extensions stay nested and cannot assert server authority. */
export function serializeOkfDocument(document: OkfDocument): string {
  if (document.profileVersion !== OKF_TOLARIA_PROFILE)
    throw new Error(`Unsupported OKF profile; expected ${OKF_TOLARIA_PROFILE}`);
  if (
    typeof document.documentType !== "string" ||
    document.documentType.trim().length === 0 ||
    document.documentType.trim().length > 120
  )
    throw new Error("OKF type is required");
  if (typeof document.content !== "string") throw new Error("OKF Markdown content is required");
  if (document.content.length > OKF_MAX_MARKDOWN_LENGTH)
    throw new Error("OKF document exceeds the export size limit");
  if (document.nature !== undefined && !isNature(document.nature))
    throw new Error("Invalid OKF nature");
  if (document.entityRefs !== undefined) parseEntityRefs(document.entityRefs);
  if (document.relations !== undefined) parseRelations(document.relations);
  const unknownMetadata = document.unknownMetadata ?? {};
  if (!isRecord(unknownMetadata)) throw new Error("Unknown metadata must be a YAML mapping");
  for (const key of Object.keys(unknownMetadata)) {
    if (ROOT_RESERVED_KEYS.has(key))
      throw new Error(`Unknown metadata conflicts with reserved key: ${key}`);
  }

  const metadata: Record<string, unknown> = {
    type: document.documentType.trim(),
    profile: OKF_TOLARIA_PROFILE,
    ...(document.nature ? { nature: document.nature } : {}),
    ...(document.entityRefs ? { entityRefs: document.entityRefs } : {}),
    ...(document.relations ? { relations: document.relations } : {}),
    ...(Object.keys(unknownMetadata).length
      ? { extensions: normalizeUnknownValue(unknownMetadata) }
      : {}),
  };
  const yaml = stringify(metadata, { lineWidth: 0 }).replace(/\n$/, "");
  return `---\n${yaml}\n---\n${document.content}`;
}

function parseEntityRefs(value: unknown): OkfEntityReference[] {
  if (!Array.isArray(value)) throw new Error("OKF entityRefs must be a list");
  return value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.kind !== "string" ||
      !ENTITY_KINDS.has(item.kind as MemoryEntityKind) ||
      typeof item.documentId !== "string" ||
      item.documentId.trim().length === 0
    )
      throw new Error("Invalid OKF entity reference");
    return { kind: item.kind as MemoryEntityKind, documentId: item.documentId };
  });
}

function parseRelations(value: unknown): NonNullable<OkfDocument["relations"]> {
  if (!Array.isArray(value)) throw new Error("OKF relations must be a list");
  return value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.documentId !== "string" ||
      item.documentId.trim().length === 0 ||
      typeof item.relation !== "string" ||
      !RELATIONS.has(item.relation as NonNullable<OkfDocument["relations"]>[number]["relation"])
    )
      throw new Error("Invalid OKF relation");
    return {
      documentId: item.documentId,
      relation: item.relation as NonNullable<OkfDocument["relations"]>[number]["relation"],
    };
  });
}

function isNature(value: unknown): value is MemoryNature {
  return typeof value === "string" && NATURES.has(value as MemoryNature);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeUnknownValue(value: unknown, ancestors = new Set<object>(), depth = 0): unknown {
  if (depth > 50) throw new Error("OKF metadata exceeds the nesting limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("Cyclic OKF metadata is unsupported");
    ancestors.add(value);
    const normalized = value.map((item) => normalizeUnknownValue(item, ancestors, depth + 1));
    ancestors.delete(value);
    return normalized;
  }
  if (!isRecord(value)) throw new Error("Unknown OKF metadata contains an unsupported value");
  if (ancestors.has(value)) throw new Error("Cyclic OKF metadata is unsupported");
  ancestors.add(value);
  const normalized = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(normalized, key, {
      value: normalizeUnknownValue(item, ancestors, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  ancestors.delete(value);
  return normalized;
}
