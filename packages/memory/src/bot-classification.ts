import type { MemoryMethodSnapshot, PreparedMemoryMethod } from "@rakazo/contracts";
import { PreparedMemoryMethodSchema } from "@rakazo/contracts";

/** User-owned classification questions prepared from a bot's instructions. */
export type MemoryClassificationMethodOption =
  PreparedMemoryMethod["questions"][number]["options"][number];
export type MemoryClassificationMethodQuestion = PreparedMemoryMethod["questions"][number];
export type PreparedMemoryClassificationMethod = PreparedMemoryMethod;
export type MemoryClassificationMethodSnapshot = Pick<
  MemoryMethodSnapshot,
  "id" | "version" | "instructions" | "prepared"
>;

export type MemoryBotClassificationExample = {
  content: string;
  reviewedQuestionKeys: string[];
  answers: Record<string, string | null>;
  neighbors: Array<{ content: string }>;
};

export type MemoryBotClassificationCandidate = {
  id: string;
  revision: number;
  content: string;
  qualification?: unknown;
};

export type MemoryBotClassificationInput = {
  method: MemoryClassificationMethodSnapshot;
  candidate: MemoryBotClassificationCandidate;
  neighbors: MemoryBotClassificationCandidate[];
  /** Only explicitly reviewed, authorized examples. Content remains untrusted data. */
  examples?: MemoryBotClassificationExample[];
  maxNeighbors?: number;
};

export type MemoryBotClassificationUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type MemoryBotClassificationSuggestion = {
  answers: Record<string, string | null>;
  abstained: boolean;
  invalidResponse?: boolean;
  abstentionReason?:
    | "no_match"
    | "input_budget"
    | "output_budget"
    | "provider_error"
    | "invalid_response";
  metadata: {
    provider: string;
    model: string;
    schemaVersion: string;
    confidence?: number;
    dimensionConfidence?: Record<string, number>;
    usage?: MemoryBotClassificationUsage;
  };
};

export type MemoryBotClassifier = (
  input: MemoryBotClassificationInput,
) => Promise<MemoryBotClassificationSuggestion>;

export const MEMORY_BOT_CLASSIFICATION_SCHEMA_VERSION = "bot-memory-classification/1";
export const MEMORY_BOT_CLASSIFICATION_MAX_QUESTIONS = 8;
export const MEMORY_BOT_CLASSIFICATION_MAX_OPTIONS = 19;
export const MEMORY_BOT_CLASSIFICATION_NO_MATCH_KEY = "none";
export const MEMORY_BOT_CLASSIFICATION_MAX_NEIGHBORS = 8;
export const MEMORY_BOT_CLASSIFICATION_MAX_EXAMPLES = 4;
export const MEMORY_BOT_CLASSIFICATION_MAX_EXAMPLE_CONFLICT_SCAN = 100;

/** Bound and validate the method snapshot before any provider sees it. */
export function validatePreparedMemoryClassificationMethod(
  method: PreparedMemoryClassificationMethod,
): boolean {
  if (!PreparedMemoryMethodSchema.safeParse(method).success) return false;
  return method.questions.every(
    (question) =>
      question.key !== MEMORY_BOT_CLASSIFICATION_NO_MATCH_KEY &&
      question.options.every((option) => option.key !== MEMORY_BOT_CLASSIFICATION_NO_MATCH_KEY),
  );
}

/** Keep neighbor selection deterministic and local after authorization. */
export function shortlistBotMemoryNeighbors<T extends MemoryBotClassificationCandidate>(
  candidate: MemoryBotClassificationCandidate,
  candidates: T[],
  maximum = MEMORY_BOT_CLASSIFICATION_MAX_NEIGHBORS,
) {
  const limit = Math.max(0, Math.min(MEMORY_BOT_CLASSIFICATION_MAX_NEIGHBORS, Math.floor(maximum)));
  const tokens = lexicalTokens(candidate.content);
  if (!limit || !tokens.size) return [];
  return candidates
    .filter(
      (item, index, all) =>
        item.id !== candidate.id &&
        item.revision > 0 &&
        item.content.trim().length > 0 &&
        all.findIndex((other) => other.id === item.id) === index,
    )
    .map((item) => ({
      item,
      score:
        canonicalContent(candidate.content) === canonicalContent(item.content)
          ? 1
          : lexicalSimilarity(tokens, lexicalTokens(item.content)),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id))
    .slice(0, limit)
    .map(({ item }) => item);
}

/** Local mode transfers only exact-content, non-conflicting human review. */
export const localMemoryBotClassifier: MemoryBotClassifier = async (input) => {
  const questions = input.method.prepared.questions;
  const examples = prepareMemoryBotClassificationExamples(input.examples, questions);
  const matching = examples.filter(
    (example) => canonicalContent(example.content) === canonicalContent(input.candidate.content),
  );
  const answers: Record<string, string | null> = {};
  for (const question of questions) {
    const values = new Set(
      matching
        .filter((example) => example.reviewedQuestionKeys.includes(question.key))
        .map((example) => example.answers[question.key])
        .filter((value): value is string | null => value === null || typeof value === "string"),
    );
    const answer = values.size === 1 ? [...values][0]! : null;
    answers[question.key] =
      answer !== null && !question.options.some((option) => option.key === answer) ? null : answer;
  }
  const abstained = Object.values(answers).every((answer) => answer === null);
  return {
    answers,
    abstained,
    metadata: {
      provider: "local-exact-review",
      model: "local-exact-review/1",
      schemaVersion: MEMORY_BOT_CLASSIFICATION_SCHEMA_VERSION,
    },
  };
};

/** Normalize provider input and reject answers outside the bot's frozen method. */
export async function classifyMemoryWithBot(
  input: MemoryBotClassificationInput,
  classifier: MemoryBotClassifier = localMemoryBotClassifier,
): Promise<MemoryBotClassificationSuggestion> {
  if (!validatePreparedMemoryClassificationMethod(input.method.prepared))
    return invalidSuggestion();
  const normalized: MemoryBotClassificationInput = {
    ...input,
    neighbors: shortlistBotMemoryNeighbors(input.candidate, input.neighbors, input.maxNeighbors),
    examples: prepareMemoryBotClassificationExamples(
      input.examples,
      input.method.prepared.questions,
    ),
  };
  let result: MemoryBotClassificationSuggestion;
  try {
    result = await classifier(normalized);
  } catch {
    return abstainSuggestion("provider_error", normalized.method.prepared);
  }
  if (!isValidSuggestion(result, normalized))
    return invalidSuggestion(result, normalized.method.prepared);
  return result;
}

export function prepareMemoryBotClassificationExamples(
  values: MemoryBotClassificationExample[] | undefined,
  questions?: PreparedMemoryClassificationMethod["questions"],
): MemoryBotClassificationExample[] {
  const questionMap = new Map(questions?.map((question) => [question.key, question]) ?? []);
  const bounded = (values ?? [])
    .slice(0, MEMORY_BOT_CLASSIFICATION_MAX_EXAMPLE_CONFLICT_SCAN)
    .map((example) => {
      const answers: Record<string, string | null> = {};
      for (const key of new Set(example.reviewedQuestionKeys)) {
        const answer = example.answers[key];
        if (
          (answer === null || typeof answer === "string") &&
          (!questions ||
            questionMap.get(key)?.options.some((option) => option.key === answer) ||
            answer === null)
        )
          answers[key] = answer;
      }
      return {
        content: example.content,
        reviewedQuestionKeys: Object.keys(answers).filter(
          (key) => !questions || questionMap.has(key),
        ),
        answers,
        neighbors: example.neighbors
          .slice(0, MEMORY_BOT_CLASSIFICATION_MAX_NEIGHBORS)
          .map(({ content }) => ({
            content: content.slice(0, 600),
          })),
      };
    });
  const byContent = new Map<string, MemoryBotClassificationExample[]>();
  for (const example of bounded) {
    const key = canonicalContent(example.content);
    byContent.set(key, [...(byContent.get(key) ?? []), example]);
  }
  return bounded
    .map((example) => {
      const conflicts = new Set<string>();
      for (const questionKey of example.reviewedQuestionKeys) {
        const answers = new Set(
          (byContent.get(canonicalContent(example.content)) ?? [])
            .filter((candidate) => candidate.reviewedQuestionKeys.includes(questionKey))
            .map((candidate) => candidate.answers[questionKey]),
        );
        if (answers.size > 1) conflicts.add(questionKey);
      }
      return {
        ...example,
        reviewedQuestionKeys: example.reviewedQuestionKeys.filter((key) => !conflicts.has(key)),
        answers: Object.fromEntries(
          Object.entries(example.answers).filter(([key]) => !conflicts.has(key)),
        ),
      };
    })
    .filter((example) => example.reviewedQuestionKeys.length > 0)
    .slice(0, MEMORY_BOT_CLASSIFICATION_MAX_EXAMPLES);
}

function isValidSuggestion(
  value: MemoryBotClassificationSuggestion,
  input: MemoryBotClassificationInput,
): boolean {
  if (!value || typeof value !== "object" || !isRecord(value.answers) || !isRecord(value.metadata))
    return false;
  if (
    typeof value.abstained !== "boolean" ||
    typeof value.metadata.provider !== "string" ||
    typeof value.metadata.model !== "string" ||
    typeof value.metadata.schemaVersion !== "string"
  )
    return false;
  const questionMap = new Map(
    input.method.prepared.questions.map((question) => [question.key, question]),
  );
  const answerKeys = Object.keys(value.answers);
  if (answerKeys.length !== questionMap.size || answerKeys.some((key) => !questionMap.has(key)))
    return false;
  for (const [key, answer] of Object.entries(value.answers)) {
    if (answer !== null && !questionMap.get(key)!.options.some((option) => option.key === answer))
      return false;
  }
  if (value.metadata.confidence !== undefined && !isUnitNumber(value.metadata.confidence))
    return false;
  if (value.metadata.dimensionConfidence !== undefined) {
    const entries = Object.entries(value.metadata.dimensionConfidence);
    if (
      !isRecord(value.metadata.dimensionConfidence) ||
      entries.some(([key, confidence]) => !questionMap.has(key) || !isUnitNumber(confidence))
    )
      return false;
  }
  if (
    value.metadata.usage !== undefined &&
    (!isRecord(value.metadata.usage) ||
      !Number.isSafeInteger(value.metadata.usage.inputTokens) ||
      !Number.isSafeInteger(value.metadata.usage.outputTokens) ||
      Number(value.metadata.usage.inputTokens) < 0 ||
      Number(value.metadata.usage.outputTokens) < 0)
  )
    return false;
  return true;
}

function abstainSuggestion(
  reason: NonNullable<MemoryBotClassificationSuggestion["abstentionReason"]>,
  method: PreparedMemoryClassificationMethod,
): MemoryBotClassificationSuggestion {
  return {
    answers: Object.fromEntries(method.questions.map(({ key }) => [key, null])),
    abstained: true,
    abstentionReason: reason,
    metadata: {
      provider: "unknown",
      model: "unknown",
      schemaVersion: MEMORY_BOT_CLASSIFICATION_SCHEMA_VERSION,
    },
  };
}

function invalidSuggestion(
  value?: MemoryBotClassificationSuggestion,
  method?: PreparedMemoryClassificationMethod,
): MemoryBotClassificationSuggestion {
  return {
    ...abstainSuggestion("invalid_response", method ?? { questions: [] }),
    invalidResponse: true,
    metadata: {
      provider: value?.metadata?.provider ?? "unknown",
      model: value?.metadata?.model ?? "unknown",
      schemaVersion: value?.metadata?.schemaVersion ?? MEMORY_BOT_CLASSIFICATION_SCHEMA_VERSION,
      ...(isUsage(value?.metadata?.usage) ? { usage: value!.metadata.usage } : {}),
    },
  };
}

function isUsage(value: unknown): value is MemoryBotClassificationUsage {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.inputTokens) &&
    Number.isSafeInteger(value.outputTokens) &&
    Number(value.inputTokens) >= 0 &&
    Number(value.outputTokens) >= 0
  );
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalContent(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .trim()
    .replace(/[\t ]+$/gm, "");
}

function lexicalTokens(value: string) {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase("und")
      .match(/[\p{L}\p{N}]{3,}/gu) ?? [],
  );
}

function lexicalSimilarity(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / (left.size + right.size - overlap);
}
