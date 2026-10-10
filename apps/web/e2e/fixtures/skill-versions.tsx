import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { AgentSkill, SkillVersion, SkillVersionDetail } from "@rakazo/contracts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { applyResolvedAppearance } from "../../src/lib/ui-appearance";
import { AgentSkillEditor } from "../../src/pages/KnowledgeSection";
import "../../src/styles.css";

/*
 * The skill panel without a server. Query parameters:
 *   skill=<id>   conflict=1 (the first Undo is refused)   theme=dark
 * Reads and writes go to a stubbed fetch holding the state in memory.
 */
const params = new URLSearchParams(window.location.search);
let conflict = params.get("conflict") === "1";

applyResolvedAppearance(params.get("theme") === "dark" ? "dark" : "light");
i18n.loadAndActivate({ locale: "en", messages: {} });

const DAY = 86_400_000;
const NOW = Date.now();
const at = (offset: number) => new Date(NOW + offset).toISOString();
const SCOUT = { kind: "bot", botId: "bot-1", botName: "Scout" } as const;

const version = (n: number, offset: number, patch: Partial<SkillVersion> = {}): SkillVersion => ({
  versionId: `v${String(n).padStart(6, "0")}-0123abcd`,
  createdAt: at(offset),
  author: SCOUT,
  nature: "modified",
  current: false,
  undone: false,
  ...patch,
});

const skill = (id: string, name: string, readOnly = false): AgentSkill => ({
  id,
  name,
  description: `${name}, step by step.`,
  content: `---\nname: ${name}\ndescription: ${name}, step by step.\n---\n\nOpen the booking tool and pick the room.\n`,
  source: readOnly ? "builtin" : "user",
  readOnly,
  createdAt: at(-5 * DAY),
  updatedAt: at(-1 * DAY),
});

const skills = new Map<string, AgentSkill>([
  ["user:rooms", skill("user:rooms", "Book a room")],
  ["user:lone-user", skill("user:lone-user", "Weekly notes")],
  ["user:lone-bot", skill("user:lone-bot", "Chase invoices")],
  ["builtin:readonly", skill("builtin:readonly", "Read a PDF", true)],
]);

const history = new Map<string, SkillVersion[]>([
  [
    "user:rooms",
    [
      version(4, -3 * 3_600_000, { undone: true }),
      version(3, -DAY, { current: true, author: { kind: "user" } }),
      version(2, -2 * DAY),
      version(1, -5 * DAY, { nature: "created" }),
    ],
  ],
  [
    "user:lone-user",
    [version(1, -DAY, { current: true, nature: "created", author: { kind: "user" } })],
  ],
  ["user:lone-bot", [version(1, -3_600_000, { current: true, nature: "created" })]],
]);

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const ok = (json: unknown) => Response.json({ json });
const refuse = (code: string, status: number, message: string) =>
  Response.json({ json: { defined: false, code, status, message } }, { status });

function answer(procedure: string, query: Record<string, string>): Response {
  const id = query.skillId ?? "";
  if (procedure === "agentSkills/list") {
    return ok(
      [...skills.values()].map(({ content: _content, createdAt: _c, updatedAt: _u, ...entry }) => ({
        ...entry,
        availability: "all",
        visibleBotIds: ["bot-1"],
      })),
    );
  }
  if (procedure === "agentSkills/get") return ok(skills.get(id));
  if (procedure === "agentSkills/versions") return ok(history.get(id) ?? []);
  if (procedure === "agentSkills/version") {
    const found = history.get(id)?.find((entry) => entry.versionId === query.versionId);
    const detail: SkillVersionDetail = {
      ...(found as SkillVersion),
      content: skills.get(id)?.content ?? "",
      files: [
        { path: "scripts/book.py", size: 1_240 },
        { path: "notes/rooms.md", size: 310 },
      ],
    };
    return ok(detail);
  }
  if (procedure === "agentSkills/undo") {
    const list = history.get(id) ?? [];
    if (conflict) {
      conflict = false;
      return refuse("CONFLICT", 409, "This skill changed. Reload and try again.");
    }
    const at = list.findIndex((entry) => entry.current);
    const target = list.findIndex((entry, index) => index > at && !entry.undone);
    if (target < 0) {
      skills.delete(id);
      return ok({ kind: "trashed" });
    }
    list[at] = { ...list[at]!, current: false, undone: true };
    list[target] = { ...list[target]!, current: true };
    return ok({ kind: "restored", skillId: id, name: skills.get(id)?.name });
  }
  if (procedure === "agentSkills/deleteVersion") {
    const list = history.get(id) ?? [];
    history.set(
      id,
      list.filter((entry) => entry.versionId !== query.versionId),
    );
    return ok({ ok: true });
  }
  return refuse("NOT_FOUND", 404, `${procedure} is not in this fixture`);
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  if (!url.pathname.startsWith("/rpc/")) return realFetch(input, init);
  await delay(120);
  const body = input instanceof Request ? await input.text() : String(init?.body ?? "{}");
  const query = (JSON.parse(body) as { json?: Record<string, string> }).json ?? {};
  return answer(url.pathname.slice("/rpc/".length), query);
};

function Fixture() {
  const [closed, setClosed] = useState("");
  const [id, setId] = useState(params.get("skill") ?? "user:rooms");
  return (
    <main className="mx-auto max-w-md bg-background px-4 py-8 text-foreground">
      {closed ? null : (
        <AgentSkillEditor
          key={id}
          skillId={id}
          onDone={(changed) => setClosed(changed ? "changed" : "unchanged")}
          onSkillChange={setId}
        />
      )}
      <output data-testid="closed">{closed}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <Fixture />
  </I18nProvider>,
);
