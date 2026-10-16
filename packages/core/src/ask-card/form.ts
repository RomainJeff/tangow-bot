import type { AskAnswers, AskQuestion, MessageBlock } from "@rakazo/contracts";
import { isApprovalAskBlock, isSecretAskBlock } from "../action-approval.js";

export type AskCardBlock = Extract<MessageBlock, { kind: "ask" }>;

declare const brand: unique symbol;
export type QuestionId = string & { readonly [brand]: "QuestionId" };
export type OptionId = string & { readonly [brand]: "OptionId" };

type ContractOption = NonNullable<AskQuestion["options"]>[number];
export type FormOption = Omit<ContractOption, "id"> & { id: OptionId };

export type FormQuestion = {
  id: QuestionId;
  header: string | null;
  /** Markdown. Labels and the header are plain text. */
  text: string;
  /** None: a free-text question. */
  options: readonly FormOption[];
  multiSelect: boolean;
  required: boolean;
};

export type NonEmpty<T> = readonly [T, ...T[]];

/** One shape for the three question cards; `encoding` is read only by this module. */
export type AskForm = {
  questions: NonEmpty<FormQuestion>;
  encoding: "answers" | "legacy-choice" | "legacy-text";
};

export type AskResponse =
  | { kind: "options"; ids: NonEmpty<OptionId>; other: string | null }
  | { kind: "text"; text: string }
  | { kind: "skipped" };

export type StoredAnswer =
  | { kind: "answers"; answers: AskAnswers }
  | { kind: "answer"; answer: string }
  | { kind: "none" };

/** The question card a block is, or null for approvals, secrets and proposals. */
export function askFormOf(block: AskCardBlock): AskForm | null {
  if (isApprovalAskBlock(block) || isSecretAskBlock(block)) return null;
  if (block.proposal || block.routine || block.spawnBot || block.created || block.confirms) {
    return null;
  }
  const [first, ...rest] = (block.questions ?? []).map(
    (question): FormQuestion => ({
      id: question.id as QuestionId,
      header: question.header?.trim() || null,
      text: question.question,
      options: (question.options ?? []).map((option) => ({ ...option, id: option.id as OptionId })),
      multiSelect: question.multiSelect === true,
      required: question.required !== false,
    }),
  );
  if (first) return { questions: [first, ...rest], encoding: "answers" };
  const options = (block.actions ?? []).map(({ id, label }) => ({ id: id as OptionId, label }));
  const question: FormQuestion = {
    id: "answer" as QuestionId,
    header: null,
    text: block.text,
    options,
    multiSelect: false,
    required: true,
  };
  return { questions: [question], encoding: options.length ? "legacy-choice" : "legacy-text" };
}

/** What `threads.answer` carries, and what the block stores once the server accepts it. */
export function encodeAnswer(
  form: AskForm,
  responses: ReadonlyMap<QuestionId, AskResponse>,
): { wire: string; stored: StoredAnswer } {
  if (form.encoding === "answers") {
    const answers: AskAnswers = {};
    for (const question of form.questions) {
      const response = responses.get(question.id) ?? { kind: "skipped" };
      const other =
        response.kind === "text"
          ? response.text
          : response.kind === "options"
            ? response.other
            : null;
      answers[question.id] = {
        ...(response.kind === "options" ? { selected: [...response.ids] } : {}),
        ...(other?.trim() ? { other: other.trim() } : {}),
        ...(response.kind === "skipped" ? { skipped: true } : {}),
      };
    }
    return { wire: JSON.stringify({ answers }), stored: { kind: "answers", answers } };
  }
  const response = responses.get(form.questions[0].id);
  const answer =
    response?.kind === "options"
      ? response.ids[0]
      : response?.kind === "text"
        ? response.text.trim()
        : "";
  return { wire: answer, stored: { kind: "answer", answer } };
}

export function storedAnswerOf(form: AskForm, block: AskCardBlock): StoredAnswer {
  if (form.encoding === "answers") {
    return block.answers && Object.keys(block.answers).length > 0
      ? { kind: "answers", answers: block.answers }
      : { kind: "none" };
  }
  return block.answer ? { kind: "answer", answer: block.answer } : { kind: "none" };
}
