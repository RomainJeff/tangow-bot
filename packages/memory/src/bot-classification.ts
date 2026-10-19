import type { MemoryMethodSnapshot, PreparedMemoryMethod } from "@rakazo/contracts";
import {
  BotMemoryClassificationSuggestionSchema,
  PreparedMemoryMethodSchema,
} from "@rakazo/contracts";

type MethodQuestion = PreparedMemoryMethod["questions"][number];
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

type MemoryBotClassificationCandidate = {
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
export const MEMORY_BOT_CLASSIFICATION_NO_MATCH_KEY = "none";
const MAX_NEIGHBORS = 8;
const MAX_EXAMPLES = 4;
const MAX_EXAMPLE_CONFLICT_SCAN = 100;

/** Bound and validate the method snapshot before any provider sees it. */
function isValidPreparedMethod(method: PreparedMemoryMethod): boolean {
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
) {
  const tokens = lexicalTokens(candidate.content);
  if (!tokens.size) return [];
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
    .slice(0, MAX_NEIGHBORS)
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
    answers[question.key] = isAllowedAnswer(question, answer) ? answer : null;
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
  if (!isValidPreparedMethod(input.method.prepared)) return invalidSuggestion();
  const normalized: MemoryBotClassificationInput = {
    ...input,
    neighbors: shortlistBotMemoryNeighbors(input.candidate, input.neighbors),
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
  if (!isValidSuggestion(result, normalized.method.prepared.questions))
    return invalidSuggestion(result, normalized.method.prepared);
  return result;
}

export function prepareMemoryBotClassificationExamples(
  values: MemoryBotClassificationExample[] | undefined,
  questions?: PreparedMemoryMethod["questions"],
): MemoryBotClassificationExample[] {
  const questionMap = new Map(questions?.map((question) => [question.key, question]) ?? []);
  const bounded = (values ?? []).slice(0, MAX_EXAMPLE_CONFLICT_SCAN).map((example) => {
    const answers: Record<string, string | null> = {};
    for (const key of new Set(example.reviewedQuestionKeys)) {
      const answer = example.answers[key];
      if (
        answer === null ||
        (typeof answer === "string" &&
          (!questions || isAllowedAnswer(questionMap.get(key), answer)))
      )
        answers[key] = answer;
    }
    return {
      content: example.content,
      reviewedQuestionKeys: Object.keys(answers).filter(
        (key) => !questions || questionMap.has(key),
      ),
      answers,
      neighbors: example.neighbors.slice(0, MAX_NEIGHBORS).map(({ content }) => ({
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
    .slice(0, MAX_EXAMPLES);
}

/** An answer is null (no match) or one of the question's own option keys. */
export function isAllowedAnswer(question: MethodQuestion | undefined, answer: unknown): boolean {
  return answer === null || Boolean(question?.options.some((option) => option.key === answer));
}

/** Exactly one allowed answer for every question of the frozen method, and nothing else. */
export function hasValidAnswers(
  answers: Record<string, unknown>,
  questions: PreparedMemoryMethod["questions"],
): boolean {
  return (
    Object.keys(answers).length === questions.length &&
    questions.every(
      (question) => question.key in answers && isAllowedAnswer(question, answers[question.key]),
    )
  );
}

function isValidSuggestion(
  value: MemoryBotClassificationSuggestion,
  questions: PreparedMemoryMethod["questions"],
): boolean {
  const parsed = BotMemoryClassificationSuggestionSchema.safeParse(value);
  if (!parsed.success) return false;
  const { answers, metadata } = parsed.data;
  return (
    hasValidAnswers(answers, questions) &&
    (metadata.confidence === undefined || isUnitNumber(metadata.confidence)) &&
    Object.keys(metadata.dimensionConfidence ?? {}).every((key) =>
      questions.some((question) => question.key === key),
    ) &&
    (metadata.usage === undefined || isUsage(metadata.usage))
  );
}

/** All-null answers for the method, attributed to whichever provider abstained. */
export function abstainSuggestion(
  reason: NonNullable<MemoryBotClassificationSuggestion["abstentionReason"]>,
  method: PreparedMemoryMethod,
  metadata: Partial<MemoryBotClassificationSuggestion["metadata"]> = {},
): MemoryBotClassificationSuggestion {
  return {
    answers: Object.fromEntries(method.questions.map(({ key }) => [key, null])),
    abstained: true,
    abstentionReason: reason,
    ...(reason === "invalid_response" ? { invalidResponse: true } : {}),
    metadata: {
      provider: "unknown",
      model: "unknown",
      schemaVersion: MEMORY_BOT_CLASSIFICATION_SCHEMA_VERSION,
      ...metadata,
    },
  };
}

function invalidSuggestion(
  value?: MemoryBotClassificationSuggestion,
  method?: PreparedMemoryMethod,
): MemoryBotClassificationSuggestion {
  const usage = value?.metadata?.usage;
  return abstainSuggestion("invalid_response", method ?? { questions: [] }, {
    ...(value?.metadata?.provider ? { provider: value.metadata.provider } : {}),
    ...(value?.metadata?.model ? { model: value.metadata.model } : {}),
    ...(value?.metadata?.schemaVersion ? { schemaVersion: value.metadata.schemaVersion } : {}),
    ...(isUsage(usage) ? { usage } : {}),
  });
}

export function isUsage(value: unknown): value is MemoryBotClassificationUsage {
  if (typeof value !== "object" || value === null) return false;
  const { inputTokens, outputTokens } = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(inputTokens) &&
    Number.isSafeInteger(outputTokens) &&
    Number(inputTokens) >= 0 &&
    Number(outputTokens) >= 0
  );
}

export function isUnitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function canonicalContent(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .trim()
    .replace(/[\t ]+$/gm, "");
}

export function lexicalTokens(value: string) {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase("und")
      .match(/[\p{L}\p{N}]{3,}/gu) ?? [],
  );
}

export function lexicalSimilarity(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / (left.size + right.size - overlap);
}
