import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { routineConfirmationBlock } from "@rakazo/core";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { AskBlock } from "../../src/components/AskCard";
import { AskCard } from "../../src/components/AskCard";
import "../../src/styles.css";

i18n.loadAndActivate({ locale: "en", messages: {} });

const CARDS: Array<[string, AskBlock]> = [
  [
    "weekly",
    routineConfirmationBlock("effect-1", {
      id: "routine-1",
      name: "Offres de la semaine",
      schedule: "Mondays at 09:00 Europe/Paris",
      prompt: "Résume les nouvelles offres de la semaine.",
      notify: false,
    }),
  ],
  [
    "once",
    routineConfirmationBlock("effect-2", {
      id: "routine-2",
      name: "Tea",
      schedule: "Once on Oct 7, 2026 at 17:00 Europe/Paris",
      prompt: "Remind me the tea is ready.",
      notify: true,
    }),
  ],
];

createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <MemoryRouter initialEntries={["/app/g/group-1"]}>
      <main className="mx-auto flex max-w-xl flex-col gap-4 bg-background p-4">
        {CARDS.map(([state, block]) => (
          <div key={state} data-testid={`routine-confirmation-${state}`}>
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
