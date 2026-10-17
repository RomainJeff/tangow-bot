import type { MessageBlock } from "@rakazo/contracts";
import type { AnswerValue, AskCardBlock, AskForm, AskSettledView } from "@rakazo/core";
import { askFormOf } from "@rakazo/core";

type Translate = (message: string, values?: Record<string, string | number>) => string;

type AppStateLike = {
  addEventListener(type: "change", listener: (state: string) => void): { remove(): void };
};

/** The message's question card: its first ask that is not an approval, a secret or a proposal. */
export function questionCardOf(
  blocks: readonly MessageBlock[],
): { block: AskCardBlock; form: AskForm } | null {
  for (const block of blocks) {
    const form = block.kind === "ask" ? askFormOf(block) : null;
    if (block.kind === "ask" && form) return { block, form };
  }
  return null;
}

/** The answer bubble, one line per question of a stack; empty when the composer answered. */
export function answerLines(view: AskSettledView, t: Translate): string[] {
  const text = (value: AnswerValue) => (value.kind === "skipped" ? t("Skipped") : value.text);
  const bubble = view.kind === "answered" ? view.bubble : null;
  if (!bubble) return [];
  if (bubble.kind === "single") return [text(bubble.value)];
  return bubble.lines.map((line) => `${line.label} — ${text(line.value)}`);
}

/** Leaving the app cancels a running hold, so nothing is sent while the person is away. */
export function interruptWhenAway(appState: AppStateLike, interrupt: () => void): () => void {
  const subscription = appState.addEventListener("change", (state) => {
    if (state !== "active") interrupt();
  });
  return () => subscription.remove();
}
