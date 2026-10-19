import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AgentSkill,
  AgentSkillCatalogEntry,
  Bot,
  MemoryDocument,
  SkillAvailability,
} from "@rakazo/contracts";
import { filterSkillList, parseSkillMd } from "@rakazo/core";
import {
  Button,
  Input,
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
  Switch,
} from "@rakazo/ui-web";
import { Check } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { formatBytes } from "../components/ArtifactFileCard";
import { downloadArtifactBytes } from "../lib/artifact-open";
import { rpc } from "../lib/rpc";

const fieldClass =
  "mt-2 w-full rounded-[11px] border border-border bg-transparent px-3.5 py-3 font-mono text-[13px] leading-relaxed text-foreground";

function rowClass(open: boolean): string {
  return `w-full rounded-[11px] px-2.5 py-2.5 text-start ${open ? "bg-muted" : "hover:bg-muted"}`;
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

/**
 * Memory documents with their own editor: Save and Cancel, never a save on blur.
 * With `onOpen` a row hands its document to the caller instead of expanding.
 */
export function MemoryDocumentList({
  load,
  epoch,
  exportFilename,
  emptyLabel,
  testId,
  onOpen,
}: {
  load: () => Promise<MemoryDocument[]>;
  /** A change reads the list again, keeping the rows shown until it answers. */
  epoch?: number;
  exportFilename: string;
  emptyLabel: ReactNode;
  testId: string;
  onOpen?: (doc: MemoryDocument) => void;
}) {
  const { t } = useLingui();
  const [docs, setDocs] = useState<MemoryDocument[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
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
        setError(null);
      })
      .catch(() => {
        if (current !== generation.current) return;
        setDocs([]);
        setError(t`Could not load`);
      });
    return () => {
      generation.current += 1;
    };
  }, [t, epoch]);

  function openDoc(doc: MemoryDocument) {
    if (onOpen) {
      onOpen(doc);
      return;
    }
    setOpenId(openId === doc.id ? null : doc.id);
    setError(null);
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
      downloadArtifactBytes(exportFilename, "text/markdown", new TextEncoder().encode(markdown));
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
            disabled={busy}
            data-opens={`memory:${doc.id}`}
            onClick={() => openDoc(doc)}
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
            <MemoryDocumentEditor
              doc={doc}
              onSaving={setBusy}
              onSaved={(updated) => {
                setDocs((current) =>
                  current.map((entry) => (entry.id === updated.id ? updated : entry)),
                );
                setOpenId(null);
              }}
              onCancel={() => setOpenId(null)}
            />
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

/**
 * One memory document's text with explicit Save and Cancel: a save on blur
 * after an accidental clear would wipe the bot's memory with no history.
 */
export function MemoryDocumentEditor({
  doc,
  onSaving,
  onSaved,
  onCancel,
}: {
  doc: MemoryDocument;
  /** Tells a list around the editor to hold its other rows while the save runs. */
  onSaving?: (saving: boolean) => void;
  onSaved: (updated: MemoryDocument) => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(doc.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (busy) return;
    setBusy(true);
    onSaving?.(true);
    setError(null);
    try {
      onSaved(
        await rpc.memory.update({
          documentId: doc.id,
          content: draft,
          expectedRevision: doc.revision,
        }),
      );
    } catch {
      setError(t`Could not save`);
      setBusy(false);
    } finally {
      onSaving?.(false);
    }
  }

  return (
    <div className="px-2.5 pb-2">
      {error ? <div className="pt-2 text-[13px] text-destructive">{error}</div> : null}
      <textarea
        value={draft}
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
        rows={Math.min(16, Math.max(4, draft.split("\n").length + 1))}
        className={fieldClass}
        dir="auto"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button variant="capsuleSecondary" size="capsule" disabled={busy} onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button
          variant="capsule"
          size="capsule"
          disabled={busy || draft === doc.content}
          onClick={() => void save()}
        >
          <Trans>Save</Trans>
        </Button>
      </div>
    </div>
  );
}

const NEW_SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when the agent should use it.
---

Steps the agent should follow.
`;

/**
 * The space's skill catalog. Space mode (no botId) manages each skill's reach:
 * disabled, every agent, or a picked set. Bot mode lists only the skills that
 * agent can install — globally disabled ones are out — with one toggle each.
 * With `onOpenEditor` a skill (or `null` for a new one) is edited elsewhere.
 */
export function AgentSkills({
  botId,
  epoch,
  onChanged,
  onOpenEditor,
}: {
  botId?: string;
  /** A change reads the list again, keeping the rows shown until it answers. */
  epoch?: number;
  /** Called once the server has confirmed a skill write. */
  onChanged?: () => void;
  onOpenEditor?: (skillId: string | null) => void;
} = {}) {
  const { t } = useLingui();
  /** `null` until the catalog is first read. */
  const [skills, setSkills] = useState<AgentSkillCatalogEntry[] | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [editing, setEditing] = useState<{ skillId: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** "all" | "active" | "disabled" | `bot:<id>`. */
  const [filter, setFilter] = useState("all");
  const generation = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  async function refresh() {
    const current = ++generation.current;
    const list = await rpc.agentSkills.list();
    if (current !== generation.current) return;
    setSkills(list);
  }

  useEffect(() => {
    const current = ++generation.current;
    void Promise.all([rpc.agentSkills.list(), botId ? [] : rpc.bots.list()])
      .then(([list, allBots]) => {
        if (current !== generation.current) return;
        setSkills(list);
        setBots(allBots.filter((bot) => !bot.archivedAt));
        setError(null);
      })
      .catch(() => {
        if (current !== generation.current) return;
        setSkills([]);
        setError(t`Could not load`);
      });
    return () => {
      generation.current += 1;
    };
  }, [t, botId, epoch]);

  function openEditor(skillId: string | null) {
    if (busy) return;
    setError(null);
    if (onOpenEditor) onOpenEditor(skillId);
    else setEditing({ skillId });
  }

  async function closeEditor(changed: boolean) {
    setEditing(null);
    if (!changed) return;
    setBusy(true);
    try {
      await refresh();
    } catch {
      setError(t`Could not load`);
    } finally {
      setBusy(false);
    }
    onChanged?.();
  }

  async function setAccess(
    entry: AgentSkillCatalogEntry,
    patch: {
      availability?: SkillAvailability;
      bots?: Array<{ botId: string; enabled: boolean }>;
    },
  ) {
    setError(null);
    try {
      const updated = await rpc.agentSkills.setAccess({ skillId: entry.id, ...patch });
      onChanged?.();
      setSkills(
        (list) => list?.map((skill) => (skill.id === updated.id ? updated : skill)) ?? null,
      );
    } catch {
      setError(t`Could not update agent access`);
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
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t`Could not import skill`);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Global -> Specific must seed the include list from the bots that can see the skill
   * now; otherwise a lone "excluded" row would flip into being the only include.
   */
  function setAvailability(entry: AgentSkillCatalogEntry, availability: SkillAvailability) {
    if (availability === entry.availability) return;
    void setAccess(entry, {
      availability,
      ...(availability === "selected"
        ? { bots: entry.visibleBotIds.map((id) => ({ botId: id, enabled: true })) }
        : {}),
    });
  }

  const availabilityOptions = [
    { value: "disabled", label: <Trans>Disabled</Trans> },
    { value: "all", label: <Trans>Global</Trans> },
    { value: "selected", label: <Trans>Specific agents</Trans> },
  ] satisfies Array<{ value: SkillAvailability; label: ReactNode }>;

  const shown = filterSkillList(skills ?? [], { query, filter, botId });

  const editorOpen = editing !== null;
  return (
    <div data-testid="bot-knowledge-skills">
      {error ? <div className="px-2.5 pb-2 text-[13px] text-destructive">{error}</div> : null}
      {!editorOpen ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 px-2.5">
          <button
            type="button"
            disabled={busy}
            data-opens="skill:new"
            onClick={() => openEditor(null)}
            className="text-[13px] text-muted-foreground hover:text-foreground"
          >
            <Trans>New skill</Trans>
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".skill,.zip"
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
            className="me-1 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <Trans>Import</Trans>
          </button>
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t`Search skills`}
            aria-label={t`Search skills`}
            data-testid="bot-knowledge-skill-search"
            className="ms-auto h-8 w-40 flex-1 sm:max-w-56"
          />
          {botId ? null : (
            <NativeSelect
              size="sm"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              aria-label={t`Filter skills`}
              data-testid="bot-knowledge-skill-filter"
            >
              <NativeSelectOption value="all">{t`All`}</NativeSelectOption>
              <NativeSelectOption value="active">{t`Active`}</NativeSelectOption>
              <NativeSelectOption value="disabled">{t`Disabled`}</NativeSelectOption>
              {bots.length > 0 ? (
                <NativeSelectOptGroup label={t`Agents`}>
                  {bots.map((bot) => (
                    <NativeSelectOption key={bot.id} value={`bot:${bot.id}`}>
                      {bot.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelectOptGroup>
              ) : null}
            </NativeSelect>
          )}
        </div>
      ) : null}
      {skills && shown.length === 0 && !editorOpen && !error ? (
        <div className="px-2.5 py-1 text-[13.5px] text-muted-foreground/80">
          {skills.length === 0 ? <Trans>No skills yet</Trans> : <Trans>No skills match</Trans>}
        </div>
      ) : null}
      {!editorOpen
        ? shown.map((entry) => {
            // Builtins are always on for every agent; only the rest carry access controls.
            const controlled = entry.source !== "builtin";
            return (
              <div
                key={entry.id}
                className="rounded-row hover:bg-muted"
                data-testid="bot-knowledge-skill"
              >
                <div className="flex items-center gap-3 pe-2.5">
                  <button
                    type="button"
                    disabled={busy}
                    data-opens={`skill:${entry.id}`}
                    onClick={() => openEditor(entry.id)}
                    className={`min-w-0 flex-1 rounded-[11px] px-2.5 pt-2.5 text-start ${
                      controlled && !botId ? "pb-1" : "pb-2.5"
                    }`}
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
                  {botId && controlled ? (
                    <Switch
                      size="sm"
                      className="shrink-0"
                      aria-label={entry.name}
                      checked={entry.visibleBotIds.includes(botId)}
                      onCheckedChange={(enabled) =>
                        void setAccess(entry, { bots: [{ botId, enabled }] })
                      }
                    />
                  ) : null}
                </div>
                {!botId && controlled ? (
                  <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5">
                    <div className="flex items-center rounded-full border border-border p-0.5 text-[12.5px]">
                      {availabilityOptions.map((option) => {
                        const on = entry.availability === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            aria-pressed={on}
                            onClick={() => setAvailability(entry, option.value)}
                            className={`rounded-full px-2.5 py-0.5 ${
                              on ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                            }`}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                    {/* ponytail: inline chips; a searchable picker only pays off past ~10 agents. */}
                    {entry.availability === "selected"
                      ? bots.map((bot) => {
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
                                void setAccess(entry, {
                                  bots: [{ botId: bot.id, enabled: !visible }],
                                })
                              }
                            >
                              {visible ? <Check aria-hidden="true" /> : null}
                              {bot.name}
                            </Button>
                          );
                        })
                      : null}
                  </div>
                ) : null}
              </div>
            );
          })
        : null}
      {editing ? <AgentSkillEditor skillId={editing.skillId} onDone={closeEditor} /> : null}
    </div>
  );
}

/**
 * One skill's SKILL.md with Save, Cancel and Delete; `skillId` null starts a
 * new skill from the template. `onDone` says whether the catalog changed.
 */
export function AgentSkillEditor({
  skillId,
  onDone,
}: {
  skillId: string | null;
  onDone: (changed: boolean) => void;
}) {
  const { t } = useLingui();
  const creating = skillId === null;
  const [skill, setSkill] = useState<AgentSkill | null>(null);
  const [draft, setDraft] = useState(creating ? NEW_SKILL_TEMPLATE : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const loaded = creating || skill !== null;

  useEffect(() => {
    if (!skillId) return;
    let cancelled = false;
    rpc.agentSkills
      .get({ skillId })
      .then((found) => {
        if (cancelled) return;
        setSkill(found);
        setDraft(found.content);
      })
      .catch(() => {
        if (!cancelled) setError(t`Could not load skill`);
      });
    return () => {
      cancelled = true;
    };
  }, [skillId, t]);

  const draftError = (() => {
    if (!loaded || skill?.readOnly || !draft.trim()) return null;
    const parsed = parseSkillMd(draft);
    return "error" in parsed ? parsed.error : null;
  })();

  async function save() {
    if (busy || !draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (skill) await rpc.agentSkills.update({ skillId: skill.id, content: draft });
      else await rpc.agentSkills.create({ content: draft });
      onDone(true);
    } catch {
      setError(t`Could not save skill`);
      setBusy(false);
    }
  }

  async function remove(target: AgentSkill) {
    if (busy) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rpc.agentSkills.remove({ skillId: target.id });
      onDone(true);
    } catch {
      setError(t`Could not delete skill`);
      setBusy(false);
    }
  }

  return (
    <div className="px-2.5 pb-2" data-testid="bot-knowledge-skill-editor">
      {error ? <div className="pb-2 text-[13px] text-destructive">{error}</div> : null}
      {skill ? (
        <div className="pb-1 text-[14px] text-foreground" dir="auto">
          {skill.name}
        </div>
      ) : null}
      {loaded ? (
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={Math.min(20, Math.max(8, draft.split("\n").length + 1))}
          readOnly={Boolean(skill?.readOnly)}
          className={fieldClass}
          dir="auto"
        />
      ) : null}
      {draftError ? (
        <p className="mt-1 text-[12px] text-destructive" dir="auto" role="alert">
          {draftError}
        </p>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        {skill && !skill.readOnly ? (
          <Button
            variant="tertiary"
            size="capsule"
            disabled={busy}
            onClick={() => void remove(skill)}
            className={`-ms-3 text-destructive hover:text-destructive ${
              confirmingDelete ? "bg-destructive/15" : ""
            }`}
          >
            {confirmingDelete ? <Trans>Confirm delete</Trans> : <Trans>Delete</Trans>}
          </Button>
        ) : null}
        <span className="flex-1" />
        <Button variant="capsuleSecondary" size="capsule" onClick={() => onDone(false)}>
          {skill?.readOnly ? <Trans>Close</Trans> : <Trans>Cancel</Trans>}
        </Button>
        {loaded && !skill?.readOnly ? (
          <Button
            variant="capsule"
            size="capsule"
            disabled={
              busy ||
              !draft.trim() ||
              Boolean(draftError) ||
              (!creating && draft === skill?.content)
            }
            onClick={() => void save()}
          >
            <Trans>Save</Trans>
          </Button>
        ) : null}
      </div>
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

/** The workspace root shows its first entries; a folder, opened on purpose, shows them all. */
const FILES_SHOWN = 5;

/**
 * The agent's working files: its computer workspace while the computer runs,
 * otherwise the last checkpoint. Rides on the existing computer.files and
 * computer.readFile RPCs, which already scope paths to this bot's home.
 */
export function AgentFiles({ botId }: { botId: string }) {
  const { t } = useLingui();
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [open, setOpen] = useState<{ path: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setOpen(null);
    setError(null);
    setExpanded(false);
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
        ? (expanded || dir ? entries : entries.slice(0, FILES_SHOWN)).map((entry) => (
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
      {!open && !dir && entries.length > FILES_SHOWN ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className={`${rowClass(false)} text-row-name text-muted-foreground`}
        >
          {expanded ? t`Show less` : t`Show more`}
        </button>
      ) : null}
    </div>
  );
}
