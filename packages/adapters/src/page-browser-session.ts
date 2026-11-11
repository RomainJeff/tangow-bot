import type {
  BrowserActResult,
  BrowserActStep,
  BrowserNavigateResult,
  BrowserSnapshotNode,
  BrowserSnapshotResult,
} from "@tangow/adapter-kit";
import { JSDOM } from "jsdom";

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='textbox']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='combobox']",
  "[role='menuitem']",
  "[contenteditable='true']",
].join(",");
/** As the live helper: a select lists at most this many option labels, each this long. */
const MAX_SELECT_OPTIONS = 30;
const MAX_OPTION_LABEL_CHARS = 80;

type DomWindow = JSDOM["window"];
type DomElement = InstanceType<DomWindow["Element"]>;

/** In-process page session used by fake/emulator browser adapters (offline). */
export class PageBrowserSession {
  private dom: JSDOM;
  private refs = new Map<string, DomElement>();
  private nextRef = 1;

  constructor(
    url = "about:blank",
    html = "<!doctype html><html><head><title></title></head><body></body></html>",
  ) {
    this.dom = new JSDOM(html, { url, contentType: "text/html", pretendToBeVisual: true });
  }

  close(): void {
    this.dom.window.close();
    this.refs.clear();
  }

  get url(): string {
    return this.dom.window.location.href;
  }

  get title(): string {
    return this.dom.window.document.title || "";
  }

  load(url: string, html: string): BrowserNavigateResult {
    this.dom.window.close();
    this.dom = new JSDOM(html, { url, contentType: "text/html", pretendToBeVisual: true });
    this.refs.clear();
    return { url: this.url, title: this.title };
  }

  snapshot(): BrowserSnapshotResult {
    const { elements, tree } = this.buildSnapshot();
    return {
      url: this.url,
      title: this.title,
      tree,
      elements,
    };
  }

  act(actions: BrowserActStep[]): BrowserActResult {
    let completed = 0;
    for (const action of actions) {
      const el = this.refs.get(action.ref);
      if (!el) {
        const snap = this.snapshot();
        return {
          ok: false,
          completed,
          url: snap.url,
          title: snap.title,
          tree: snap.tree,
          elements: snap.elements,
          error: `Unknown element ref "${action.ref}". Call browser_snapshot and use a fresh ref.`,
          fallback: "computer_act",
        };
      }
      try {
        this.applyAction(el, action);
      } catch (error) {
        const snap = this.snapshot();
        return {
          ok: false,
          completed,
          url: snap.url,
          title: snap.title,
          tree: snap.tree,
          elements: snap.elements,
          error: error instanceof Error ? error.message : String(error),
          fallback: "computer_act",
        };
      }
      completed += 1;
    }
    const snap = this.snapshot();
    return {
      ok: true,
      completed,
      url: snap.url,
      title: snap.title,
      tree: snap.tree,
      elements: snap.elements,
    };
  }

  private applyAction(el: DomElement, action: BrowserActStep): void {
    const win = this.dom.window;
    if (action.kind === "click") {
      if (el instanceof win.HTMLAnchorElement && el.href) {
        const next = new URL(el.href, this.url);
        if (next.href !== this.url) {
          // jsdom does not load a new document on location changes. Fall back so
          // callers use computer_act on the live browser instead of a false success.
          throw new Error(
            "In-process page browser cannot navigate links. Use computer_act on the desktop browser.",
          );
        }
      }
      el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
      // Checkboxes toggle via jsdom activation behavior. Force radios on; do not
      // invert checkboxes after dispatchEvent (that would undo the activation).
      if (el instanceof win.HTMLInputElement && el.type === "radio") {
        el.checked = true;
      }
      return;
    }
    if (action.kind === "fill" || action.kind === "type") {
      const text = action.text;
      if (el instanceof win.HTMLInputElement || el instanceof win.HTMLTextAreaElement) {
        if (action.kind === "fill") el.value = text;
        else el.value = `${el.value}${text}`;
        el.dispatchEvent(new win.Event("input", { bubbles: true }));
        el.dispatchEvent(new win.Event("change", { bubbles: true }));
        return;
      }
      if (el instanceof win.HTMLSelectElement) {
        const match = [...el.options].find((o) => o.value === text || optionLabel(o) === text);
        el.value = match ? match.value : text;
        el.dispatchEvent(new win.Event("change", { bubbles: true }));
        return;
      }
      if (el.getAttribute("contenteditable") === "true") {
        if (action.kind === "fill") el.textContent = text;
        else el.textContent = `${el.textContent ?? ""}${text}`;
        el.dispatchEvent(new win.Event("input", { bubbles: true }));
        return;
      }
      throw new Error(`Ref ${action.ref} is not fillable`);
    }
    throw new Error(`Unsupported browser action ${action.kind}`);
  }

  private buildSnapshot(): { elements: BrowserSnapshotNode[]; tree: string } {
    this.refs.clear();
    const win = this.dom.window;
    const elements: BrowserSnapshotNode[] = [];
    const lines: string[] = [];
    const nodes = win.document.querySelectorAll(INTERACTIVE_SELECTOR);
    for (const node of nodes) {
      if (!(node instanceof win.Element)) continue;
      if (isIgnored(win, node)) continue;
      const ref = `e${this.nextRef++}`;
      this.refs.set(ref, node);
      const role = roleFor(win, node);
      const name = nameFor(win, node);
      const value = valueFor(win, node);
      const tag = node.tagName.toLowerCase();
      const entry: BrowserSnapshotNode = { ref, role, name, tag };
      if (value !== undefined) entry.value = value;
      if (node instanceof win.HTMLInputElement && node.type === "password") entry.password = true;
      if (node instanceof win.HTMLSelectElement) {
        const labels = selectableOptions(win, node).map(optionLabel).filter(Boolean);
        entry.options = labels.slice(0, MAX_SELECT_OPTIONS);
        if (labels.length > MAX_SELECT_OPTIONS) entry.optionsTruncated = true;
      }
      // As the live helper, which refuses to act on these.
      if (node.matches(":disabled") || node.getAttribute("aria-disabled") === "true") {
        entry.disabled = true;
      }
      elements.push(entry);
      const valuePart = value !== undefined ? ` value=${JSON.stringify(value)}` : "";
      lines.push(
        `- ${role} ${JSON.stringify(name)} [${ref}]${valuePart}${entry.disabled ? " disabled" : ""}`,
      );
    }
    return { elements, tree: lines.join("\n") || "(no interactive elements)" };
  }
}

function isIgnored(win: DomWindow, el: DomElement): boolean {
  if (el instanceof win.HTMLInputElement && el.type === "hidden") return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  return false;
}

function roleFor(win: DomWindow, el: DomElement): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "summary") return "button";
  if (tag === "input" && el instanceof win.HTMLInputElement) {
    const type = (el.type || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "submit" || type === "button" || type === "reset") return "button";
    return "textbox";
  }
  return tag;
}

function nameFor(win: DomWindow, el: DomElement): string {
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return aria;
  if (el instanceof win.HTMLInputElement || el instanceof win.HTMLTextAreaElement) {
    const label = el.labels?.[0]?.textContent?.trim();
    if (label) return label;
    if (el.placeholder?.trim()) return el.placeholder.trim();
    if (el.name?.trim()) return el.name.trim();
  }
  const text = el.textContent?.replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, 120);
  return el.tagName.toLowerCase();
}

function valueFor(win: DomWindow, el: DomElement): string | undefined {
  if (el instanceof win.HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") return el.checked ? "checked" : "unchecked";
    if (el.type === "password") return el.value ? "••••" : "";
    return el.value;
  }
  if (el instanceof win.HTMLSelectElement)
    return [...el.selectedOptions].map(optionLabel).join(", ");
  if (el instanceof win.HTMLTextAreaElement) return el.value;
  return undefined;
}

type OptionElement = InstanceType<DomWindow["HTMLOptionElement"]>;

function selectableOptions(
  win: DomWindow,
  select: InstanceType<DomWindow["HTMLSelectElement"]>,
): OptionElement[] {
  return [...select.options].filter(
    (option) =>
      !option.disabled &&
      !option.closest("optgroup[disabled]") &&
      win.getComputedStyle(option).display !== "none",
  );
}

/** What the model reads and names: the trimmed label, cut as the snapshot cuts it. */
function optionLabel(option: OptionElement): string {
  return option.label.trim().slice(0, MAX_OPTION_LABEL_CHARS);
}

/**
 * In-process page sessions for fake/emulator providers.
 * Callers must pass an isolation key that includes bot identity on Team
 * Computers (see `pageBrowserSessionKey`), never the bare computer id alone.
 */
export class PageBrowserSessionStore {
  private readonly sessions = new Map<string, PageBrowserSession>();

  get(sessionKey: string): PageBrowserSession {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = new PageBrowserSession();
      this.sessions.set(sessionKey, session);
    }
    return session;
  }

  clear(sessionKey?: string): void {
    if (sessionKey) {
      this.sessions.get(sessionKey)?.close();
      this.sessions.delete(sessionKey);
    } else {
      for (const session of this.sessions.values()) session.close();
      this.sessions.clear();
    }
  }
}

/**
 * Isolate page state per computer and running bot on Team Computers.
 * Prefer `context.botId` (the running bot). `computer.botId` is the home key and
 * is shared by every bot on a Team Computer, so it alone cannot isolate sessions.
 * Do not include screen-lease fences: the same bot reacquiring the computer must
 * keep the in-process page and element refs across renewals and takeover resumes.
 */
export function pageBrowserSessionKey(
  computer: { id: string; botId: string },
  context?: { botId?: string; memberId?: string },
): string {
  const bot = context?.botId?.trim() || computer.botId;
  return `${computer.id}::${context?.memberId ? `${bot}:${context.memberId}` : bot}`;
}
