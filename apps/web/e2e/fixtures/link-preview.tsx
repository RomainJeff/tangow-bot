import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { MessageBlock } from "@rakazo/contracts";
import { ComposerLinkPreview, ComposerShell } from "@rakazo/ui-web";
import { createRoot } from "react-dom/client";
import type { MessageItem } from "../../src/lib/thread-items";
import { placeHoverPill } from "../../src/pages/shell/hover-pill-placement";
import {
  MessageHoverActions,
  UserMessageActions,
} from "../../src/pages/shell/message-hover-actions";
import { MessageView } from "../../src/pages/shell/message-view";
import "../../src/styles.css";

const i18n = setupI18n({ locale: "en", messages: { en: {} } });
const IMAGE = { artifactId: "art-1", width: 1200, height: 628 };

function message(id: string, role: "user" | "bot", blocks: unknown[]): MessageItem {
  return {
    kind: "message",
    id,
    ts: "2026-10-05T10:00:00.000Z",
    blocks: blocks as MessageBlock[],
    ...(role === "bot" ? { role, botId: "bot-1" } : { role, source: "app" }),
  } as MessageItem;
}

const MESSAGES: MessageItem[] = [
  message("large", "bot", [
    { kind: "text", text: "Here is the study: https://example.com/study" },
    {
      kind: "link_preview",
      url: "https://example.com/study",
      format: "large",
      title: "The city that removed its traffic lights",
      image: IMAGE,
    },
  ]),
  message("compact", "user", [
    { kind: "text", text: "Did you see https://news.example.org/briefing ?" },
    {
      kind: "link_preview",
      url: "https://news.example.org/briefing",
      format: "compact",
      title: "Three-year results of a trial without traffic lights",
      image: IMAGE,
    },
  ]),
  message("link-only", "bot", [
    { kind: "text", text: "https://calm.example.net/principles" },
    {
      kind: "link_preview",
      url: "https://calm.example.net/principles",
      format: "compact",
      title: "Principles of Calm Technology",
    },
  ]),
  message("icon", "bot", [
    { kind: "text", text: "The review: https://www.example.fr/tests/laptop-review" },
    {
      kind: "link_preview",
      url: "https://www.example.fr/tests/laptop-review",
      format: "compact",
      title: "Laptop review: two weeks on battery",
      image: { artifactId: "art-1", width: 180, height: 180, fit: "contain" },
    },
  ]),
  message("letter", "bot", [
    {
      kind: "text",
      text: "Voici l'article du Figaro :\nhttps://www.lefigaro.fr/actualite-france/j-ai-eu-peur-je-suis-rentre-chez-moi-la-colere-et-l-inquietude-des-eleves-et-leurs-parents-face-aux-violences-devant-les-lycees-20261004",
    },
    {
      kind: "link_preview",
      url: "https://www.lefigaro.fr/actualite-france/j-ai-eu-peur-je-suis-rentre-chez-moi-la-colere-et-l-inquietude-des-eleves-et-leurs-parents-face-aux-violences-devant-les-lycees-20261004",
      format: "compact",
      title:
        "J'ai eu peur je suis rentre chez moi la colere et l'inquietude des eleves et leurs parents face aux violences devant les lycees",
    },
  ]),
  message("plain", "bot", [
    { kind: "text", text: "The roadmap is here: https://docs.example.net/roadmap" },
  ]),
  message("mention-bot", "bot", [
    {
      kind: "text",
      text: [
        "Relu. Trois points à trancher, tous notés dans [Compte rendu du 12 octobre](https://docs.example.org/document/d/1/edit) :",
        "",
        "- le périmètre iOS, déjà chiffré dans https://code.example.org/acme/app/pull/193",
        "- la date de gel, alignée sur https://tracker.example.net/team/plan",
        "- le guide https://wiki.example.org/handbook et le fil https://forum.example.com/t/unrelated",
      ].join("\n"),
    },
    {
      kind: "link_mention",
      url: "https://docs.example.org/document/d/1/edit",
      icon: { artifactId: "art-1" },
    },
    {
      kind: "link_mention",
      url: "https://code.example.org/acme/app/pull/193",
      title: "Put the iPhone key's eye and copy icons inside the field, like the web",
      icon: { artifactId: "art-1" },
    },
    { kind: "link_mention", url: "https://tracker.example.net/team/plan" },
    {
      kind: "link_mention",
      url: "https://wiki.example.org/handbook",
      title: "Handbook",
      icon: { artifactId: "art-broken" },
    },
  ]),
  message("mention-user", "user", [
    {
      kind: "text",
      text: "Tu peux relire https://www.notion.example.com/acme/Roadmap-Q4-3f9a2c7e81d04b5f et https://design.example.net/file/onboarding avant demain ?",
    },
    {
      kind: "link_mention",
      url: "https://www.notion.example.com/acme/Roadmap-Q4-3f9a2c7e81d04b5f",
      title: "Roadmap Q4",
    },
    {
      kind: "link_mention",
      url: "https://design.example.net/file/onboarding",
      title: "Onboarding flow",
      icon: { artifactId: "art-1" },
    },
  ]),
  message("photo", "user", [
    { kind: "text", text: "https://images.example.com/p.jpg" },
    {
      kind: "link_preview",
      url: "https://images.example.com/p.jpg",
      format: "photo",
      image: IMAGE,
    },
  ]),
];

function Row({ message: row }: { message: MessageItem }) {
  return (
    <div
      data-message-id={row.id}
      className="group group/message relative"
      onPointerEnter={(event) => placeHoverPill(event.currentTarget)}
    >
      <div className={`relative flex ${row.role === "user" ? "justify-end" : "justify-start"}`}>
        <div
          data-testid="message-bubble-frame"
          className={`relative min-w-0 w-full ${row.role === "user" ? "flex flex-col items-end" : ""}`}
        >
          {row.role !== "user" ? (
            <MessageHoverActions
              message={row}
              previewMessageId={row.id}
              onReply={() => undefined}
              onReact={async () => undefined}
              voiceReady={false}
              speaking={false}
              onSpeak={() => undefined}
            />
          ) : null}
          <MessageView
            artifactTarget={{ botId: "bot-1" }}
            chrome="row"
            message={row}
            inGroup={false}
            showAuthor={false}
            showAvatar={false}
            onOpenBot={() => undefined}
            peerBot={() => undefined}
            onRefresh={async () => undefined}
            onBotChanged={async () => undefined}
            onAddRoutine={() => undefined}
          />
        </div>
      </div>
      {row.role === "user" ? (
        <UserMessageActions message={row} previewMessageId={row.id} onEdit={() => undefined} />
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 bg-background px-3 py-8 text-foreground">
      {MESSAGES.map((entry) => (
        <Row key={entry.id} message={entry} />
      ))}
      <ComposerShell
        data-testid="composer-bar"
        attachments={
          <ComposerLinkPreview
            site="lefigaro.fr"
            title="J'ai eu peur je suis rentre chez moi la colere et l'inquietude des eleves et leurs parents face aux violences devant les lycees"
            removeLabel="Remove preview"
          />
        }
      >
        <div className="min-h-9" />
      </ComposerShell>
    </main>
  </I18nProvider>,
);
