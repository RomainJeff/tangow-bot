import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterContext,
  BrowserActRequest,
  BrowserActResult,
  ComputerRef,
  DecisionRequest,
} from "@rakazo/adapter-kit";
import {
  browserActFromTool,
  browserNavigateFromTool,
  FakeBrowserProvider,
  FakeDecisionProvider,
  pageBrowserSessionKey,
} from "@rakazo/adapters";

export type CorpusLang = "fr" | "en";
export type TargetFamily = "distractors" | "density" | "forms" | "none";
export type OutcomeClass = "landed" | "dialog" | "error" | "auth" | "unchanged";

export interface CorpusPage {
  url: string;
  title: string;
  /** Body markup only; the builder wraps it in a document with `title`. */
  html: string;
}

export interface TargetCase {
  id: string;
  family: TargetFamily;
  /** Language of the page. */
  lang: CorpusLang;
  /** Language of `target` when it differs from the page (crossed case). */
  targetLang?: CorpusLang;
  kind: "click" | "fill" | "type";
  page: CorpusPage;
  target: string;
  /** Labeled by element, never by ref: refs depend on the session. */
  expected: { role: string; name: string } | "none";
}

export interface OutcomeCase {
  id: string;
  family: "outcome";
  lang: CorpusLang;
  /** A hard case the verification is expected to leave `uncertain` rather than misclassify. */
  boundary?: true;
  before: CorpusPage;
  after: CorpusPage;
  action: { kind: "click" | "fill" | "type"; role: string; name: string };
  expected: OutcomeClass;
}

export type DecisionCase = TargetCase | OutcomeCase;

export interface BuiltDecisionCase {
  caseId: string;
  purpose: "target" | "verify";
  /** `fr`, `en`, or `cross` when the target description and page languages differ. */
  lang: CorpusLang | "cross";
  family: TargetFamily | "outcome";
  boundary: boolean;
  /** The exact request production sends for this case. */
  request: DecisionRequest;
  requestHash: string;
  /** Option key of the right answer: a ref, `none`, or an outcome class. */
  expectedKey: string;
  optionCount: number;
}

export const DECISION_CORPUS_DIR = fileURLToPath(
  new URL("./fixtures/decision/cases/", import.meta.url),
);

const OUTCOME_CLASSES: readonly OutcomeClass[] = ["landed", "dialog", "error", "auth", "unchanged"];
const TARGET_FAMILIES: readonly TargetFamily[] = ["distractors", "density", "forms", "none"];
/** Mirrors the roles `browser_act` offers per kind; the builder fails loudly if they drift. */
const ACTION_ROLES = {
  click: ["link", "tab"],
  fill: ["textbox", "searchbox", "combobox"],
  type: ["textbox", "searchbox", "combobox"],
} as const;
/** Placeholder text for fill/type; the outcome request never carries field values. */
const FILL_TEXT = "exemple";

export function loadDecisionCorpus(directory = DECISION_CORPUS_DIR): DecisionCase[] {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort();
  const cases = files.map((file) => {
    const parsed = parseDecisionCase(JSON.parse(readFileSync(path.join(directory, file), "utf8")));
    assert.equal(`${parsed.id}.json`, file, `case id must match its file name: ${file}`);
    return parsed;
  });
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, "duplicate case id");
  return cases;
}

/** Closed schema. Rejects any URL outside `.test`, so no real site can enter the corpus. */
export function parseDecisionCase(value: unknown): DecisionCase {
  assert.ok(value && typeof value === "object", "case must be an object");
  const raw = value as Record<string, unknown>;
  assert.ok(typeof raw.id === "string" && /^[a-z0-9-]+$/.test(raw.id), "case id");
  const where = `case ${raw.id}`;
  assert.ok(raw.lang === "fr" || raw.lang === "en", `${where}: lang`);
  if (raw.family === "outcome") {
    assert.deepEqual(
      Object.keys(raw).sort(),
      ["action", "after", "before", "expected", "family", "id", "lang"]
        .concat(raw.boundary === undefined ? [] : ["boundary"])
        .sort(),
      `${where}: keys`,
    );
    assert.ok(raw.boundary === undefined || raw.boundary === true, `${where}: boundary`);
    parsePage(raw.before, where);
    parsePage(raw.after, where);
    const action = raw.action as Record<string, unknown>;
    assert.ok(action && typeof action === "object", `${where}: action`);
    assert.deepEqual(Object.keys(action).sort(), ["kind", "name", "role"], `${where}: action`);
    const kind = action.kind as keyof typeof ACTION_ROLES;
    assert.ok(kind in ACTION_ROLES, `${where}: action.kind`);
    assert.ok(
      (ACTION_ROLES[kind] as readonly string[]).includes(String(action.role)),
      `${where}: action.role must be a role browser_act targets for ${kind}`,
    );
    assert.ok(typeof action.name === "string" && action.name, `${where}: action.name`);
    assert.ok(OUTCOME_CLASSES.includes(raw.expected as OutcomeClass), `${where}: expected`);
    return structuredClone(raw) as unknown as OutcomeCase;
  }
  assert.ok(TARGET_FAMILIES.includes(raw.family as TargetFamily), `${where}: family`);
  assert.deepEqual(
    Object.keys(raw).sort(),
    ["expected", "family", "id", "kind", "lang", "page", "target"]
      .concat(raw.targetLang === undefined ? [] : ["targetLang"])
      .sort(),
    `${where}: keys`,
  );
  assert.ok(
    raw.targetLang === undefined ||
      (raw.targetLang !== raw.lang && /^(fr|en)$/.test(String(raw.targetLang))),
    `${where}: targetLang must differ from lang`,
  );
  assert.ok(raw.kind === "click" || raw.kind === "fill" || raw.kind === "type", `${where}: kind`);
  parsePage(raw.page, where);
  assert.ok(typeof raw.target === "string" && raw.target.trim(), `${where}: target`);
  assert.ok(raw.target.length <= 200, `${where}: target is too long for browser_act`);
  if (raw.expected !== "none") {
    const expected = raw.expected as Record<string, unknown>;
    assert.ok(expected && typeof expected === "object", `${where}: expected`);
    assert.deepEqual(Object.keys(expected).sort(), ["name", "role"], `${where}: expected`);
    assert.ok(
      (ACTION_ROLES[raw.kind] as readonly string[]).includes(String(expected.role)),
      `${where}: expected.role is never offered for ${raw.kind}`,
    );
  }
  return structuredClone(raw) as unknown as TargetCase;
}

function parsePage(value: unknown, where: string): void {
  assert.ok(value && typeof value === "object", `${where}: page`);
  const page = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(page).sort(), ["html", "title", "url"], `${where}: page keys`);
  assert.ok(typeof page.title === "string" && typeof page.html === "string", `${where}: page`);
  assertTestUrl(String(page.url), where);
  for (const match of page.html.matchAll(/(?:href|src|action)\s*=\s*"([^"]*)"/g)) {
    const link = match[1]!;
    if (link.startsWith("/") || link.startsWith("#")) continue;
    assertTestUrl(link, where);
  }
}

function assertTestUrl(value: string, where: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    assert.fail(`${where}: invalid URL`);
  }
  assert.ok(
    url.protocol === "https:" && url.hostname.endsWith(".test"),
    `${where}: URLs must be https://<name>.test/`,
  );
}

const context: AdapterContext = {
  operationId: "decision-corpus",
  traceId: "decision-corpus",
  spaceId: "corpus",
  userId: "corpus",
  runId: "decision-corpus",
  signal: new AbortController().signal,
};
const computer: ComputerRef = {
  id: "corpus",
  botId: "corpus",
  kind: "fake",
  providerRef: "corpus",
};

class RecordedCallError extends Error {}

/** Returns `after` as the post-action page; the in-process session cannot follow a link. */
class AfterPageBrowser extends FakeBrowserProvider {
  constructor(
    before: CorpusPage,
    private readonly after: CorpusPage,
  ) {
    super({ pages: { [before.url]: { html: documentFor(before) } } });
  }

  override async act(
    target: ComputerRef,
    request: BrowserActRequest,
    actContext: AdapterContext,
  ): Promise<BrowserActResult> {
    const session = this.sessions.get(pageBrowserSessionKey(target, actContext));
    session.load(this.after.url, documentFor(this.after));
    return { ok: true, completed: request.actions.length, ...session.snapshot() };
  }
}

/**
 * Drives `browserActFromTool` exactly as a run does, with a scripted decision
 * provider, and returns the requests production would send. The last scripted
 * step records and throws, so resolution hands back `needsRef` and nothing acts
 * on a guess.
 */
export async function buildDecisionRequests(corpus: DecisionCase[]): Promise<BuiltDecisionCase[]> {
  const built: BuiltDecisionCase[] = [];
  for (const item of corpus) {
    built.push(item.family === "outcome" ? await buildOutcome(item) : await buildTarget(item));
  }
  return built;
}

async function buildTarget(item: TargetCase): Promise<BuiltDecisionCase> {
  const browser = new FakeBrowserProvider({
    pages: { [item.page.url]: { html: documentFor(item.page) } },
  });
  const provider = new FakeDecisionProvider({ script: [new RecordedCallError()] });
  await openPage(browser, item.page.url);
  const step =
    item.kind === "click"
      ? { kind: item.kind, target: item.target }
      : { kind: item.kind, target: item.target, text: FILL_TEXT };
  const result = await browserActFromTool(
    browser,
    computer,
    context,
    { actions: [step] },
    { provider, secrets: [] },
  );
  assert.ok("needsRef" in result && result.needsRef, `case ${item.id}: expected needsRef`);
  const request = onlyCall(provider, item.id);
  const options = choiceOptions(request, "target", item.id);
  const expectedKey =
    item.expected === "none" ? "none" : optionKey(options, item.expected, item.id);
  return {
    caseId: item.id,
    purpose: "target",
    lang: item.targetLang ? "cross" : item.lang,
    family: item.family,
    boundary: false,
    request,
    requestHash: requestHash(request),
    expectedKey,
    optionCount: Object.keys(options).length,
  };
}

async function buildOutcome(item: OutcomeCase): Promise<BuiltDecisionCase> {
  const browser = new AfterPageBrowser(item.before, item.after);
  const label = `${item.action.role} ${JSON.stringify(item.action.name)}`;
  const provider = new FakeDecisionProvider({
    script: [
      (request) => {
        const key = optionKey(choiceOptions(request, "target", item.id), item.action, item.id);
        return {
          answers: {
            target: { type: "choice", choice: key, confidence: 1, probabilities: { [key]: 1 } },
          },
        };
      },
      new RecordedCallError(),
    ],
  });
  await openPage(browser, item.before.url);
  const step =
    item.action.kind === "click"
      ? { kind: item.action.kind, target: label }
      : { kind: item.action.kind, target: label, text: FILL_TEXT };
  const result = await browserActFromTool(
    browser,
    computer,
    context,
    { actions: [step] },
    { provider, secrets: [] },
  );
  assert.ok(result.ok && !("outcome" in result), `case ${item.id}: expected an unverified act`);
  assert.equal(provider.calls.length, 2, `case ${item.id}: expected target then verify`);
  const request = provider.calls[1]!;
  const options = choiceOptions(request, "outcome", item.id);
  assert.ok(Object.hasOwn(options, item.expected), `case ${item.id}: unknown outcome class`);
  return {
    caseId: item.id,
    purpose: "verify",
    lang: item.lang,
    family: "outcome",
    boundary: item.boundary === true,
    request,
    requestHash: requestHash(request),
    expectedKey: item.expected,
    optionCount: Object.keys(options).length,
  };
}

async function openPage(browser: FakeBrowserProvider, url: string): Promise<void> {
  const opened = await browserNavigateFromTool(browser, computer, context, { url });
  assert.ok(!("error" in opened && opened.error), `cannot open ${url}`);
}

function onlyCall(provider: FakeDecisionProvider, id: string): DecisionRequest {
  assert.equal(provider.calls.length, 1, `case ${id}: expected one decision request`);
  return provider.calls[0]!;
}

function choiceOptions(
  request: DecisionRequest,
  question: string,
  id: string,
): Record<string, string> {
  const asked = request.questions[question];
  assert.ok(asked?.type === "choice", `case ${id}: expected a ${question} choice`);
  return asked.options;
}

function optionKey(
  options: Record<string, string>,
  element: { role: string; name: string },
  id: string,
): string {
  const label = `${element.role} ${JSON.stringify(element.name)}`;
  const keys = Object.keys(options).filter((key) => options[key] === label);
  assert.equal(keys.length, 1, `case ${id}: ${label} must be offered exactly once`);
  return keys[0]!;
}

function documentFor(page: CorpusPage): string {
  return `<!doctype html><html><head><title>${escapeHtml(page.title)}</title></head><body>${page.html}</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** sha256 of canonical JSON (sorted keys): any change to the request changes the hash. */
export function requestHash(request: DecisionRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

/** One hash over every case's request hash, recorded to show which corpus was run. */
export function corpusHash(built: BuiltDecisionCase[]): string {
  const lines = built.map((item) => `${item.caseId}:${item.requestHash}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
