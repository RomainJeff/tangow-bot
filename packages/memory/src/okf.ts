import type { MemoryQualification } from "@rakazo/contracts";
import {
  MemoryEntityRefSchema,
  MemoryNatureSchema,
  MemoryQualificationSchema,
} from "@rakazo/contracts";
import { parseDocument } from "yaml";
import { isRecord, normalizeJsonValue, titleFor } from "./shared.js";

type Relation = NonNullable<MemoryQualification["relations"]>[number];

export const OKF_TOLARIA_PROFILE = "okf-tolaria/0.1" as const;
export const OKF_MAX_MARKDOWN_LENGTH = 1_000_000;

export type OkfEntityReference = NonNullable<MemoryQualification["entityRefs"]>[number];

export type OkfDocument = {
  profileVersion: typeof OKF_TOLARIA_PROFILE;
  documentType: string;
  nature?: MemoryQualification["nature"];
  entityRefs?: OkfEntityReference[];
  relations?: Relation[];
  /** Markdown payload is retained exactly, including its trailing newline. */
  content: string;
  /** Unknown imported fields are inert extension values, never canonical authority. */
  unknownMetadata?: Record<string, unknown>;
};

const RelationSchema = MemoryQualificationSchema.shape.relations.unwrap().element;
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
  const nature = MemoryNatureSchema.optional().safeParse(parsed.nature);
  if (!nature.success) throw new Error("Invalid OKF nature");
  const entityRefs =
    parsed.entityRefs === undefined ? undefined : parseEntityRefs(parsed.entityRefs);
  const relations = parsed.relations === undefined ? undefined : parseRelations(parsed.relations);
  if (parsed.extensions !== undefined && !isRecord(parsed.extensions))
    throw new Error("OKF extensions must be a YAML mapping");
  const unknownMetadata = Object.create(null) as Record<string, unknown>;
  const extensions = (parsed.extensions ?? {}) as Record<string, unknown>;
  // Plain assignment on a null-prototype target keeps `__proto__` an ordinary own key.
  for (const [key, value] of Object.entries(extensions))
    unknownMetadata[key] = normalizeJsonValue(value);
  for (const [key, value] of Object.entries(parsed)) {
    if (!ROOT_RESERVED_KEYS.has(key)) {
      if (Object.hasOwn(unknownMetadata, key))
        throw new Error(`Duplicate unknown OKF metadata field: ${key}`);
      unknownMetadata[key] = normalizeJsonValue(value);
    }
  }
  const contentStart = closing.index + closing[0].length;
  const content = markdown.slice(contentStart);
  return {
    profileVersion: OKF_TOLARIA_PROFILE,
    documentType: parsed.type.trim(),
    ...(nature.data ? { nature: nature.data } : {}),
    ...(entityRefs ? { entityRefs } : {}),
    ...(relations ? { relations } : {}),
    content,
    ...(Object.keys(unknownMetadata).length ? { unknownMetadata } : {}),
  };
}

function parseEntityRefs(value: unknown): OkfEntityReference[] {
  if (!Array.isArray(value)) throw new Error("OKF entityRefs must be a list");
  return value.map((item) => {
    const ref = MemoryEntityRefSchema.safeParse(item);
    if (!ref.success || !ref.data.documentId.trim())
      throw new Error("Invalid OKF entity reference");
    return ref.data;
  });
}

function parseRelations(value: unknown): Relation[] {
  if (!Array.isArray(value)) throw new Error("OKF relations must be a list");
  return value.map((item) => {
    const relation = RelationSchema.safeParse(item);
    if (!relation.success || !relation.data.documentId.trim())
      throw new Error("Invalid OKF relation");
    return relation.data;
  });
}

/** The proposal an OKF document imports as: its body, profile fields, and unresolved links kept as metadata. */
export function okfMemory(markdown: string) {
  const parsed = parseOkfDocument(markdown);
  return {
    title: titleFor(parsed.content),
    content: parsed.content,
    qualification: {
      subjects: [],
      profileVersion: parsed.profileVersion,
      documentType: parsed.documentType,
      nature: parsed.nature,
      unknownMetadata: {
        ...(parsed.unknownMetadata ?? {}),
        ...(parsed.entityRefs ? { unresolvedEntityRefs: parsed.entityRefs } : {}),
        ...(parsed.relations ? { unresolvedRelations: parsed.relations } : {}),
      },
    } satisfies MemoryQualification,
  };
}
