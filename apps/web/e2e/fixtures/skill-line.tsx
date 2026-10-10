import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageView } from "../../src/pages/shell/message-view";
import { skillPageView } from "../../src/pages/shell/skill-link";
import "../../src/styles.css";

const i18n = setupI18n({ locale: "en", messages: { en: {} } });
const uid = (digit: string) => digit.repeat(32);
/** The catalog the reader sees now: "Book a room" was renamed since its line was written. */
const CATALOG = [
  { id: "user:meeting-rooms", uid: uid("a") },
  { id: "user:invoices", uid: uid("b") },
  { id: "user:long", uid: uid("e") },
];

function message(id: string, blocks: unknown[]): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq: 1,
    role: "bot",
    botId: "bot-1",
    blocks: blocks as MessageBlock[],
    createdAt: "2026-10-10T10:00:00.000Z",
  } as ThreadMessage;
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
            canAnswer={false}
            message={row}
            inGroup={row.id === "group"}
            showAuthor={false}
            showAvatar={false}
            onAnswer={async () => undefined}
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
