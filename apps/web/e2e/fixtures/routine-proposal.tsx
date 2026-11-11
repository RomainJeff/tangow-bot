import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { settleRoutineAsk } from "@tangow/core";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { AskBlock } from "../../src/components/AskCard";
import { AskCard } from "../../src/components/AskCard";
import "../../src/styles.css";

i18n.loadAndActivate({ locale: "en", messages: {} });

const pending: AskBlock = {
  kind: "ask",
  approvalEffectId: "effect-1",
  proposal: "routine",
  text: "Je m'en occupe chaque lundi matin ?",
  detail: "name: Offres de la semaine",
  status: "pending",
  actions: [
    { id: "allow", label: "Create routine", outcome: "created" },
    { id: "deny", label: "Not now", outcome: "cancelled" },
  ],
  routine: {
    name: "Offres de la semaine",
    schedule: "Mondays at 09:00 Europe/Paris",
    prompt: "Résume les nouvelles offres de la semaine. Ne m'écris que s'il y en a.",
    notify: true,
  },
};

const CARDS: Array<[string, AskBlock]> = [
  ["pending", pending],
  [
    "created",
    settleRoutineAsk(
      { ...pending, status: "answered", answer: "allow" },
      { ...pending.routine!, id: "routine-1" },
      "created",
    ),
  ],
  ["not-now", { ...pending, status: "answered", answer: "deny" }],
  ["dismissed", { ...pending, status: "answered", answer: "dismissed" }],
  ["failed", { ...pending, status: "answered", answer: "allow", failed: true }],
];

createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <MemoryRouter initialEntries={["/app/bot-1"]}>
      <main className="mx-auto flex max-w-xl flex-col gap-4 bg-background p-4">
        {CARDS.map(([state, block]) => (
          <div key={state} data-testid={`routine-proposal-${state}`}>
            <AskCard
              block={block}
              canAnswer={true}
              onAnswer={async () => {}}
              messageId={state}
              botId="bot-1"
            />
          </div>
        ))}
      </main>
    </MemoryRouter>
  </I18nProvider>,
);
