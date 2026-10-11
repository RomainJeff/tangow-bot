import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { MessageBlock } from "@rakazo/contracts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { MessageItem } from "../../src/lib/thread-items";
import { MessageView } from "../../src/pages/shell/message-view";
import { skillPageView } from "../../src/pages/shell/skill-link";
import "../../src/styles.css";

const i18n = setupI18n({ locale: "en", messages: { en: {} } });
/** A line written while skills had uids still carries one; it opens by its id. */
const uid = (digit: string) => digit.repeat(32);
const CATALOG = [{ id: "user:rooms" }, { id: "user:invoices" }, { id: "user:long" }];

function message(id: string, blocks: unknown[]): MessageItem {
  return {
    kind: "message",
    id,
    ts: "2026-10-10T10:00:00.000Z",
    role: "bot",
    botId: "bot-1",
    blocks: blocks as MessageBlock[],
  } as MessageItem;
}

const line = (change: string, skillId: string, name: string, skillUid: string) => ({
  kind: "skill_source",
  skillUid,
  skillId,
  name,
  change,
});

const MESSAGES = [
  message("learned", [
    { kind: "text", text: "Booked Tuesday at 14:00." },
    line("learned", "user:rooms", "Book a room", uid("a")),
  ]),
  message("report", [
    { kind: "text", text: "**3 new invoices**" },
    line("updated", "user:invoices", "Relever les factures", uid("b")),
    line("deleted", "user:old", "Old checklist", uid("c")),
  ]),
  message("alone", [line("updated", "user:gone", "A skill the reader cannot open", uid("d"))]),
  message("lookalike", [{ kind: "text", text: "Skill learned · Book a room" }]),
  message("lookalike-link", [
    { kind: "text", text: "[Skill learned · Book a room](https://example.test/skills)" },
  ]),
  message("long", [
    { kind: "text", text: "Done." },
    line(
      "learned",
      "user:long",
      "Book a room for the whole team across every office, then confirm by email with the agenda",
      uid("e"),
    ),
  ]),
  message("group", [
    { kind: "text", text: "Filed in the team folder." },
    line("learned", "user:rooms", "Book a room", uid("a")),
  ]),
];

function Thread() {
  const [opened, setOpened] = useState("");
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-4 bg-background px-3 py-8 text-foreground">
      {MESSAGES.map((row) => (
        <div key={row.id} data-message-id={row.id}>
          <MessageView
            artifactTarget={{ botId: "bot-1" }}
            chrome="row"
            message={row}
            inGroup={row.id === "group"}
            showAuthor={false}
            showAvatar={false}
            onOpenBot={() => undefined}
            onOpenPeerMessages={() => undefined}
            peerBot={() => undefined}
            onRefresh={async () => undefined}
            onBotChanged={async () => undefined}
            onAddRoutine={() => undefined}
            onOpenSkill={
              row.id === "group"
                ? undefined
                : async (skill) =>
                    setOpened(JSON.stringify(await skillPageView(skill, async () => CATALOG)))
            }
          />
        </div>
      ))}
      <output data-testid="opened">{opened}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <Thread />
  </I18nProvider>,
);
