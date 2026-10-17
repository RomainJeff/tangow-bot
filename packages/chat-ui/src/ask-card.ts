import type { AskCardBlock, AskCardIntents, AskCardView, AskForm, Presenter } from "@rakazo/core";
import { createAskCard, resolveAskCardView } from "@rakazo/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

export type UseAskCardOptions = {
  block: AskCardBlock;
  form: AskForm;
  messageId: string;
  waiting: boolean;
  onAnswer: (wire: string) => Promise<void>;
  present: Presenter;
};

/** The question card's state for one ask message; mount it again for another message. */
export function useAskCard(options: UseAskCardOptions): { view: AskCardView; act: AskCardIntents } {
  const latest = useRef(options);
  latest.current = options;
  const [card] = useState(() =>
    createAskCard({
      form: options.form,
      key: options.messageId,
      waiting: options.waiting,
      send: (wire) =>
        // Rendered as no longer waiting while the effect below has not run yet: the hold may
        // still end, and the card settles as no longer active, so the message is never shown.
        !latest.current.waiting
          ? Promise.resolve({ ok: false, message: "" } as const)
          : latest.current.onAnswer(wire).then(
              () => ({ ok: true }) as const,
              (error: unknown) =>
                ({
                  ok: false,
                  message: error instanceof Error ? error.message : String(error),
                }) as const,
            ),
      present: (change, apply) => latest.current.present(change, apply),
    }),
  );
  useEffect(() => card.setWaiting(options.waiting), [card, options.waiting]);
  useEffect(() => card.interrupt, [card]);
  const view = useSyncExternalStore(card.subscribe, card.view, card.view);
  return {
    view: resolveAskCardView(options.block, options.form, view, options.waiting),
    act: card,
  };
}
