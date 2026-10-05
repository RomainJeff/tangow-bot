import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import { ComposerLinkPreview, ComposerShell } from "@rakazo/ui-web";
import { createRoot } from "react-dom/client";
import { placeHoverPill } from "../../src/pages/shell/hover-pill-placement";
import {
  MessageHoverActions,
  UserMessageActions,
} from "../../src/pages/shell/message-hover-actions";
import { MessageView } from "../../src/pages/shell/message-view";
import "../../src/styles.css";

const i18n = setupI18n({ locale: "en", messages: { en: {} } });
const IMAGE = { artifactId: "art-1", width: 1200, height: 628 };

function message(id: string, role: "user" | "bot", blocks: unknown[]): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    seq: 1,
    role,
    blocks: blocks as MessageBlock[],
    createdAt: "2026-10-05T10:00:00.000Z",
    ...(role === "bot" ? { botId: "bot-1" } : {}),
  } as ThreadMessage;
}

const MESSAGES: ThreadMessage[] = [
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
    { kind: "text", text: "The front page: https://www.example.fr/" },
    {
      kind: "link_preview",
      url: "https://www.example.fr/",
      format: "compact",
      title: "Example, tech news and tests",
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

function Row({ message: row }: { message: ThreadMessage }) {
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
            canAnswer={false}
            message={row}
            inGroup={false}
            showAuthor={false}
            showAvatar={false}
            onAnswer={async () => undefined}
            onOpenBot={() => undefined}
            onOpenPeerMessages={() => undefined}
            peerBot={() => undefined}
            onRefresh={async () => undefined}
            onBotChanged={async () => undefined}
            onAddRoutine={() => undefined}
          />
        </div>
      </div>
      {row.role === "user" ? <UserMessageActions message={row} onEdit={() => undefined} /> : null}
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
