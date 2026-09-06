import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentSkill, AgentSkillCatalogEntry, Bot, MemoryDocument } from "@rakazo/contracts";
import { parseSkillMd } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { Check } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { formatBytes } from "../components/ArtifactFileCard";
import { rpc } from "../lib/rpc";

const fieldClass =
  "mt-2 w-full rounded-[11px] border border-border bg-transparent px-3.5 py-3 font-mono text-[13px] leading-relaxed text-foreground";

function rowClass(open: boolean): string {
  return `w-full rounded-[11px] px-2.5 py-2.5 text-start ${open ? "bg-muted" : "hover:bg-muted"}`;
}

type KnowledgeTab = "memory" | "skills" | "files";

/**
 * What the agent knows, editable: its own memory document and the space's
 * agent skills. Space-wide memory lives in the Memory settings overlay.
 * Rides entirely on the existing memory.* and agentSkills.* RPCs.
 */
export function KnowledgeSection({ botId }: { botId: string }) {
  const [tab, setTab] = useState<KnowledgeTab>("memory");
  return (
    <div className="mt-6" data-testid="bot-knowledge">
      <div className="mb-3 text-[14px] text-muted-foreground">
        <Trans>Knowledge</Trans>
      </div>
      <div className="mb-3 flex items-center gap-2 text-[14px]">
        {(
          [
            { value: "memory", label: <Trans>Memory</Trans> },
            { value: "skills", label: <Trans>Skills</Trans> },
            { value: "files", label: <Trans>Files</Trans> },
          ] satisfies Array<{ value: KnowledgeTab; label: ReactNode }>
        ).map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={tab === option.value}
            onClick={() => setTab(option.value)}
            className={`rounded-lg px-2.5 py-1 ${
              tab === option.value ? "bg-muted text-foreground" : "text-muted-foreground"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {tab === "memory" ? (
        <MemoryDocumentList
          key={botId}
          load={() => rpc.memory.list({ botId, scope: "bot" })}
          exportFilename="memory.md"
          emptyLabel={<Trans>Nothing remembered yet</Trans>}
          testId="bot-knowledge-memory"
        />
      ) : null}
      {tab === "skills" ? <AgentSkills /> : null}
      {tab === "files" ? <AgentFiles key={botId} botId={botId} /> : null}
    </div>
  );
}

/** The space's shared memory documents, mounted in the Memory settings overlay. */
export function SpaceMemorySection() {
  return (
    <div className="mt-6" data-testid="space-memory-documents">
      <div className="mb-2 text-[12.5px] uppercase tracking-[0.08em] text-muted-foreground/80">
        <Trans>Shared documents</Trans>
      </div>
      <MemoryDocumentList
        load={() => rpc.memory.list({ scope: "user" })}
        exportFilename="space-memory.md"
        emptyLabel={<Trans>Nothing remembered yet</Trans>}
        testId="space-memory-list"
      />
    </div>
  );
}

function MemoryDocumentList({
  load,
  exportFilename,
  emptyLabel,
  testId,
}: {
  load: () => Promise<MemoryDocument[]>;
  exportFilename: string;
  emptyLabel: ReactNode;
  testId: string;
}) {
  const { t } = useLingui();
  const [docs, setDocs] = useState<MemoryDocument[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const current = ++generation.current;
    void loadRef
      .current()
      .then((list) => {
        if (current !== generation.current) return;
        setDocs(list);
      })
      .catch(() => {
        if (current !== generation.current) return;
        setDocs([]);
        setError(t`Could not load`);
      });
    return () => {
      generation.current += 1;
    };
  }, [t]);

  function openDoc(doc: MemoryDocument) {
    setOpenId(doc.id);
    setDraft(doc.content);
    setError(null);
  }

  async function save(doc: MemoryDocument) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await rpc.memory.update({ documentId: doc.id, content: draft });
      setDocs((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      setOpenId(null);
    } catch {
      setError(t`Could not save`);
    } finally {
      setBusy(false);
    }
  }

  async function exportMarkdown() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Re-fetch through the section's own loader so the file is current,
      // then sync the list so the export matches what is displayed.
      const fresh = await loadRef.current();
      generation.current += 1;
      setDocs(fresh);
      const markdown = fresh.map((doc) => `# ${doc.path}\n\n${doc.content}`).join("\n\n");
      const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = exportFilename;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(t`Could not load`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid={testId}>
      {error ? <div className="px-2.5 pb-2 text-[13px] text-destructive">{error}</div> : null}
      {docs.length === 0 && !error ? (
        <div className="px-2.5 py-1 text-[13.5px] text-muted-foreground/80">{emptyLabel}</div>
      ) : null}
      {docs.map((doc) => (
        <div key={doc.id}>
          <button
            type="button"
            onClick={() => (openId === doc.id ? setOpenId(null) : openDoc(doc))}
            className={rowClass(openId === doc.id)}
          >
            <span className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-[14px] text-foreground" dir="auto">
                {doc.path}
              </span>
              <span className="shrink-0 text-[12px] text-muted-foreground/80">
                <Trans>rev {doc.revision}</Trans>
              </span>
            </span>
          </button>
          {openId === doc.id ? (
            <div className="px-2.5 pb-2">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={Math.min(16, Math.max(4, draft.split("\n").length + 1))}
                className={fieldClass}
                dir="auto"
              />
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busy || draft === doc.content}
                  onClick={() => void save(doc)}
                  className="rounded-lg bg-muted px-3 py-1.5 text-[13px] text-foreground disabled:opacity-50"
                >
                  <Trans>Save</Trans>
                </button>
                <button
                  type="button"
                  onClick={() => setOpenId(null)}
                  className="rounded-lg px-3 py-1.5 text-[13px] text-muted-foreground"
                >
                  <Trans>Cancel</Trans>
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ))}
      {docs.length ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void exportMarkdown()}
          className="mt-2 px-2.5 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <Trans>Download as markdown</Trans>
        </button>
      ) : null}
    </div>
  );
}

const NEW_SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when the agent should use it.
---

Steps the agent should follow.
`;

export function AgentSkills() {
  const { t } = useLingui();
  const [skills, setSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [open, setOpen] = useState<AgentSkill | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const generation = useRef(0);
  const selection = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  async function refresh() {
    const current = ++generation.current;
    const list = await rpc.agentSkills.list();
    if (current !== generation.current) return;
    setSkills(list);
  }

  useEffect(() => {
    const current = ++generation.current;
    void Promise.all([rpc.agentSkills.list(), rpc.bots.list()])
      .then(([list, allBots]) => {
        if (current !== generation.current) return;
        setSkills(list);
        setBots(allBots.filter((bot) => !bot.archivedAt));
      })
      .catch(() => {
        if (current !== generation.current) return;
        setSkills([]);
        setError(t`Could not load`);
      });
    return () => {
      generation.current += 1;
    };
  }, [t]);

  async function openSkill(entry: AgentSkillCatalogEntry) {
    if (busy) return;
    const current = ++selection.current;
    setCreating(false);
    setConfirmingDelete(false);
    setError(null);
    try {
      const skill = await rpc.agentSkills.get({ skillId: entry.id });
      // A slower response must not clobber a newer selection or a fresh draft.
      if (current !== selection.current) return;
      setOpen(skill);
      setDraft(skill.content);
    } catch {
      if (current !== selection.current) return;
      setError(t`Could not load skill`);
    }
  }

  async function setAccess(
    entry: AgentSkillCatalogEntry,
    patch: { availability?: "all" | "selected"; bot?: { botId: string; enabled: boolean } },
  ) {
    setError(null);
    try {
      const updated = await rpc.agentSkills.setAccess({ skillId: entry.id, ...patch });
      setSkills((list) => list.map((skill) => (skill.id === updated.id ? updated : skill)));
    } catch {
      setError(t`Could not update agent access`);
    }
  }

  async function save() {
    if (busy || !draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        await rpc.agentSkills.create({ content: draft });
      } else if (open) {
        await rpc.agentSkills.update({ skillId: open.id, content: draft });
      }
      setOpen(null);
      setCreating(false);
      setConfirmingDelete(false);
      try {
        await refresh();
      } catch {
        setError(t`Could not load`);
      }
    } catch {
      setError(t`Could not save skill`);
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      await rpc.agentSkills.import({ data: btoa(binary) });
      try {
        await refresh();
      } catch {
        setError(t`Could not load`);
      }
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t`Could not import skill`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(skill: AgentSkill) {
    if (busy) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    const skillId = skill.id;
    setBusy(true);
    setError(null);
    try {
      await rpc.agentSkills.remove({ skillId });
      if (open?.id === skillId) {
        setOpen(null);
        setConfirmingDelete(false);
      }
      try {
        await refresh();
      } catch {
        setError(t`Could not load`);
      }
    } catch {
      setError(t`Could not delete skill`);
    } finally {
      setBusy(false);
    }
  }

  const editorOpen = creating || open;
  const draftError = (() => {
    if (!editorOpen || open?.readOnly || !draft.trim()) return null;
    const parsed = parseSkillMd(draft);
    return "error" in parsed ? parsed.error : null;
  })();
  return (
    <div data-testid="bot-knowledge-skills">
      {error ? <div className="px-2.5 pb-2 text-[13px] text-destructive">{error}</div> : null}
      {skills.length === 0 && !editorOpen && !error ? (
        <div className="px-2.5 py-1 text-[13.5px] text-muted-foreground/80">
          <Trans>No skills yet</Trans>
        </div>
      ) : null}
      {!editorOpen
        ? skills.map((entry) => (
            <div
              key={entry.id}
              className="rounded-[11px] hover:bg-muted"
              data-testid="bot-knowledge-skill"
            >
              <button
                type="button"
                onClick={() => void openSkill(entry)}
                className={`w-full rounded-[11px] px-2.5 pt-2.5 text-start ${entry.readOnly ? "pb-2.5" : "pb-1"}`}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-[14px] text-foreground" dir="auto">
                    {entry.name}
                  </span>
                  {entry.readOnly ? (
                    <span className="shrink-0 text-[12px] text-muted-foreground/80">
                      <Trans>read-only</Trans>
                    </span>
                  ) : null}
                </span>
                <span
                  className="mt-0.5 block truncate text-[12.5px] text-muted-foreground/80"
                  dir="auto"
                >
                  {entry.description}
                </span>
              </button>
              {entry.readOnly ? null : (
                <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5">
                  <Button
                    type="button"
                    variant={entry.availability === "all" ? "default" : "outline"}
                    size="xs"
                    className="rounded-full"
                    aria-pressed={entry.availability === "all"}
                    onClick={() =>
                      void setAccess(entry, {
                        availability: entry.availability === "all" ? "selected" : "all",
                      })
                    }
                  >
                    {entry.availability === "all" ? <Check aria-hidden="true" /> : null}
                    <Trans>All agents</Trans>
                  </Button>
                  {bots.map((bot) => {
                    const visible = entry.visibleBotIds.includes(bot.id);
                    return (
                      <Button
                        key={bot.id}
                        type="button"
                        variant={visible ? "default" : "outline"}
                        size="xs"
                        className="rounded-full"
                        aria-pressed={visible}
                        onClick={() =>
                          void setAccess(entry, { bot: { botId: bot.id, enabled: !visible } })
                        }
                      >
                        {visible ? <Check aria-hidden="true" /> : null}
                        {bot.name}
                      </Button>
                    );
                  })}
                </div>
              )}
            </div>
          ))
        : null}
      {editorOpen ? (
        <div className="px-2.5 pb-2">
          {open ? (
            <div className="pb-1 text-[14px] text-foreground" dir="auto">
              {open.name}
            </div>
          ) : null}
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={Math.min(20, Math.max(8, draft.split("\n").length + 1))}
            readOnly={Boolean(open?.readOnly)}
            className={fieldClass}
            dir="auto"
          />
          {draftError ? (
            <p className="mt-1 text-[12px] text-destructive" dir="auto" role="alert">
              {draftError}
            </p>
          ) : null}
          <div className="mt-2 flex items-center gap-2">
            {!open?.readOnly ? (
              <button
                type="button"
                disabled={
                  busy ||
                  !draft.trim() ||
                  Boolean(draftError) ||
                  (!creating && draft === open?.content)
                }
                onClick={() => void save()}
                className="rounded-lg bg-muted px-3 py-1.5 text-[13px] text-foreground disabled:opacity-50"
              >
                <Trans>Save</Trans>
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                selection.current += 1;
                setOpen(null);
                setCreating(false);
                setConfirmingDelete(false);
              }}
              className="rounded-lg px-3 py-1.5 text-[13px] text-muted-foreground"
            >
              {open?.readOnly ? <Trans>Close</Trans> : <Trans>Cancel</Trans>}
            </button>
            {open && !open.readOnly ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove(open)}
                className={`ms-auto rounded-lg px-3 py-1.5 text-[13px] ${
                  confirmingDelete ? "bg-destructive/15 text-destructive" : "text-destructive"
                }`}
              >
                {confirmingDelete ? <Trans>Confirm delete</Trans> : <Trans>Delete</Trans>}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-center">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              selection.current += 1;
              setOpen(null);
              setCreating(true);
              setConfirmingDelete(false);
              setDraft(NEW_SKILL_TEMPLATE);
              setError(null);
            }}
            className="px-2.5 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <Trans>New skill</Trans>
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".skill"
            className="hidden"
            data-testid="bot-knowledge-skill-import"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importFile(file);
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
            className="px-2.5 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <Trans>Import</Trans>
          </button>
        </div>
      )}
    </div>
  );
}

type WorkspaceEntry = { path: string; kind: "file" | "dir"; size: number };

function entryName(entryPath: string): string {
  const segments = entryPath.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? entryPath;
}

/** Directories first, then files, each alphabetical, so the list is stable. */
function sortEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return entryName(a.path).localeCompare(entryName(b.path));
  });
}

/**
 * The agent's working files: its computer workspace while the computer runs,
 * otherwise the last checkpoint. Rides on the existing computer.files and
 * computer.readFile RPCs, which already scope paths to this bot's home.
 */
function AgentFiles({ botId }: { botId: string }) {
  const { t } = useLingui();
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [open, setOpen] = useState<{ path: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setOpen(null);
    setError(null);
    void rpc.computer
      .files({ botId, path: dir })
      .then((list) => {
        if (current !== generation.current) return;
        setEntries(sortEntries(list));
      })
      .catch(() => {
        if (current !== generation.current) return;
        setEntries([]);
        setError(t`Could not load`);
      });
    return () => {
      generation.current += 1;
    };
  }, [botId, dir, t]);

  async function openFile(entry: WorkspaceEntry) {
    if (busy) return;
    const current = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const file = await rpc.computer.readFile({ botId, path: entry.path });
      if (current !== generation.current) return;
      setOpen(file);
    } catch (failure) {
      if (current !== generation.current) return;
      // A binary file fails the server's UTF-8 decode, and an oversized one
      // comes back as a readable BAD_REQUEST message.
      setError(failure instanceof Error ? failure.message : t`Could not read this file`);
    } finally {
      setBusy(false);
    }
  }

  function download(file: { path: string; content: string }) {
    const url = URL.createObjectURL(new Blob([file.content]));
    const link = document.createElement("a");
    link.href = url;
    link.download = entryName(file.path);
    link.click();
    URL.revokeObjectURL(url);
  }

  const segments = dir.split("/").filter(Boolean);
  return (
    <div data-testid="bot-knowledge-files">
      <div className="flex flex-wrap items-baseline gap-1 px-2.5 pb-2 text-[12.5px] text-muted-foreground/80">
        <button
          type="button"
          onClick={() => setDir("")}
          aria-label={t`Workspace root`}
          className={dir ? "hover:text-foreground/75" : "text-muted-foreground"}
        >
          /
        </button>
        {segments.map((segment, index) => (
          <button
            key={segments.slice(0, index + 1).join("/")}
            type="button"
            onClick={() => setDir(segments.slice(0, index + 1).join("/"))}
            className={
              index === segments.length - 1 ? "text-muted-foreground" : "hover:text-foreground/75"
            }
            dir="auto"
          >
            {segment} /
          </button>
        ))}
      </div>
      {error ? <div className="px-2.5 pb-2 text-[13px] text-destructive">{error}</div> : null}
      {open ? (
        <div className="px-2.5 pb-2">
          <div className="pb-1 text-[14px] text-foreground" dir="auto">
            {entryName(open.path)}
          </div>
          <textarea
            value={open.content}
            readOnly
            rows={Math.min(20, Math.max(6, open.content.split("\n").length + 1))}
            className={fieldClass}
            dir="auto"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => download(open)}
              className="rounded-lg bg-muted px-3 py-1.5 text-[13px] text-foreground"
            >
              <Trans>Download</Trans>
            </button>
            <button
              type="button"
              onClick={() => setOpen(null)}
              className="rounded-lg px-3 py-1.5 text-[13px] text-muted-foreground"
            >
              <Trans>Close</Trans>
            </button>
          </div>
        </div>
      ) : null}
      {!open && entries.length === 0 && !error ? (
        <div className="px-2.5 py-1 text-[13.5px] text-muted-foreground/80">
          <Trans>No files yet</Trans>
        </div>
      ) : null}
      {!open
        ? entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              disabled={busy}
              onClick={() => {
                if (entry.kind === "dir") {
                  setDir(entry.path);
                  return;
                }
                void openFile(entry);
              }}
              className={rowClass(false)}
            >
              <span className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-[14px] text-foreground" dir="auto">
                  {entry.kind === "dir" ? `${entryName(entry.path)}/` : entryName(entry.path)}
                </span>
                {entry.kind === "file" ? (
                  <span className="shrink-0 text-[12px] text-muted-foreground/80">
                    {formatBytes(entry.size)}
                  </span>
                ) : null}
              </span>
            </button>
          ))
        : null}
    </div>
  );
}
