import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { SessionEntrySchema } from "@tangow/contracts";
import { projectThreadView } from "@tangow/core";
import { createRef, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Transcript } from "../../src/pages/shell/transcript";
import "../../src/styles.css";

i18n.loadAndActivate({ locale: "en", messages: {} });

const image = (name: string) => ({
  kind: "image",
  artifactId: `art_${name}`,
  mimeType: "image/svg+xml",
  name: `${name}.svg`,
});

let seq = 0;
function entry(body: object) {
  const id = `fx-${seq}`;
  const parent = seq === 0 ? null : `fx-${seq - 1}`;
  const at = seq;
  seq += 1;
  return SessionEntrySchema.parse({
    id,
    sessionId: "ses_stack",
    seq: at,
    parentId: parent,
    ts: new Date(Date.UTC(2026, 10, 2, 9, 0, at)).toISOString(),
    ...body,
  });
}

const botImage = (name: string) =>
  entry({ botId: "bot_pixel", type: "bot.text", payload: { blocks: [image(name)] } });

const START = [
  entry({
    type: "user.message",
    payload: {
      blocks: ["p1", "p2", "p3", "p4", "p5"].map(image),
      source: "app",
    },
  }),
  botImage("a"),
  botImage("b"),
  botImage("c"),
];

function App() {
  const [entries, setEntries] = useState(START);
  useEffect(() => {
    const add = () => setEntries((current) => [...current, botImage(`n${current.length}`)]);
    window.addEventListener("add-image", add);
    return () => window.removeEventListener("add-image", add);
  }, []);
  const view = useMemo(() => projectThreadView(entries, { imageStacks: true }), [entries]);
  const scrollRef = useMemo(() => createRef<HTMLDivElement>(), []);
  const followingRef = useMemo(() => ({ current: true }), []);
  return (
    <main className="mx-auto flex h-screen max-w-2xl flex-col bg-background px-3.5 text-foreground">
      <Transcript
        scrollRef={scrollRef}
        followingRef={followingRef}
        artifactTarget={{ botId: "bot_pixel" }}
        inGroup={false}
        view={view}
        olderCursor={null}
        loadingOlder={false}
        running={false}
        workingBots={[]}
        onLoadOlder={() => undefined}
        onOpenBot={() => undefined}
        onAnswer={async () => undefined}
        onReply={() => undefined}
        onEdit={() => undefined}
        rewindFromItemId={null}
        onReact={async () => undefined}
        onJumpToMessage={() => undefined}
        onOpenPeerMessages={() => undefined}
        peerBot={() => ({ color: "#6b7280", name: "Pixel" })}
        onRefresh={async () => undefined}
        onBotChanged={async () => undefined}
        onAddRoutine={() => undefined}
        voiceReady={false}
        speakingMessageId={null}
        onSpeak={() => undefined}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <App />
  </I18nProvider>,
);
