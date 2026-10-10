import { Trans, useLingui } from "@lingui/react/macro";
import type { SkillVersion, SkillVersionDetail } from "@rakazo/contracts";
import { canUndoSkillVersion, showsSkillVersions, skillVersionSubline } from "@rakazo/core";
import { Button, cn, SettingRow, Surface } from "@rakazo/ui-web";
import { ChevronLeft, Undo2 } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { LoadingRows } from "./bot-page/page-kit";
import { applyUndo, formatVersionDate, refusalMessage } from "./skill-versions";

function useVersionWords() {
  const { t } = useLingui();
  return {
    learned: t`learned`,
    updated: t`updated`,
    you: t`You`,
    unknown: t`Updated`,
    undone: t`Undone`,
  };
}

/** The date of a version or a deleted skill, worded as the thread's time markers are. */
export function useVersionDate(): (iso: string) => string {
  const { t, i18n } = useLingui();
  const words = { locale: i18n.locale || "en", today: t`Today`, yesterday: t`Yesterday` };
  return (iso) => formatVersionDate(iso, words);
}

/**
 * A skill's history under its editor, only once it has something to show. Undo goes back one
 * version and the list follows in place; a version opens to be read.
 */
export function SkillVersions({
  skillId,
  dirty,
  onOpen,
  onRestored,
  onTrashed,
}: {
  skillId: string;
  /** The editor holds unsaved edits, which reading the skill back after an Undo would drop. */
  dirty: boolean;
  onOpen: (versionId: string) => void;
  /**
   * The skill may have changed: read it again under this id, which a rename undone changes. A
   * refused Undo passes the same id, since the refusal means a newer version landed.
   */
  onRestored: (skillId: string) => void;
  /** Undo removed the skill: it now sits in Recently deleted. */
  onTrashed: () => void;
}) {
  const { t } = useLingui();
  const words = useVersionWords();
  const versionDate = useVersionDate();
  const [versions, setVersions] = useState<SkillVersion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const list = await rpc.agentSkills.versions({ skillId });
      if (current === generation.current) setVersions(list);
    } catch {
      if (current === generation.current) setVersions([]);
    }
  }, [skillId]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  async function undo() {
    const current = versions?.find((version) => version.current);
    if (!current || busy || dirty) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.agentSkills.undo({
        skillId,
        expectedVersionId: current.versionId,
      });
      if (result.kind === "trashed") {
        onTrashed();
        return;
      }
      setVersions((list) => (list ? applyUndo(list) : list));
      onRestored(result.skillId);
      if (result.skillId === skillId) await load();
    } catch (failure) {
      setError(refusalMessage(failure) ?? t`Could not undo`);
      onRestored(skillId);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!versions || !showsSkillVersions(versions)) return null;
  const rows = versions;
  return (
    <section className="mt-6 flex flex-col gap-1.5" data-testid="skill-versions">
      <div className="mx-3.5 flex items-center justify-between gap-3">
        <h2 className="text-label text-muted-foreground">
          <Trans>Versions</Trans>
        </h2>
        <Button
          variant="tertiary"
          size="capsule"
          className="-me-3"
          disabled={busy || !canUndoSkillVersion(rows)}
          onClick={() => void undo()}
        >
          <Undo2 aria-hidden="true" />
          <Trans>Undo</Trans>
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mx-3.5 text-meta text-destructive">
          {error}
        </p>
      ) : null}
      <Surface className="overflow-hidden bg-background">
        {rows.map((version, index) => (
          <Fragment key={version.versionId}>
            {index > 0 ? <div aria-hidden className="ms-3.5 h-px bg-border" /> : null}
            <SettingRow
              label={
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "transition-colors duration-(--duration-arrive) ease-quiet motion-reduce:transition-none",
                      version.undone && "text-muted-foreground",
                    )}
                  >
                    {versionDate(version.createdAt)}
                  </span>
                  <span
                    aria-hidden
                    data-current={version.current}
                    className={cn(
                      "size-1.5 shrink-0 rounded-full bg-foreground transition-opacity duration-(--duration-arrive) ease-quiet motion-reduce:transition-none",
                      version.current ? "opacity-100" : "opacity-0",
                    )}
                  />
                </span>
              }
              subline={skillVersionSubline(version, words)}
              chevron
              aria-current={version.current ? "true" : undefined}
              data-testid="skill-version"
              onClick={() => onOpen(version.versionId)}
            />
          </Fragment>
        ))}
      </Surface>
    </section>
  );
}

/** One version, read only. The current one cannot be deleted. */
export function SkillVersionView({
  skillId,
  versionId,
  onBack,
}: {
  skillId: string;
  versionId: string;
  onBack: () => void;
}) {
  const { t } = useLingui();
  const words = useVersionWords();
  const versionDate = useVersionDate();
  const [version, setVersion] = useState<SkillVersionDetail | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc.agentSkills.version({ skillId, versionId }).then(
      (found) => {
        if (!cancelled) setVersion(found);
      },
      () => {
        if (!cancelled) setError(t`Could not load`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [skillId, versionId, t]);

  async function remove() {
    if (busy) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rpc.agentSkills.deleteVersion({ skillId, versionId });
      onBack();
    } catch (failure) {
      setError(refusalMessage(failure) ?? t`Could not delete`);
      setConfirming(false);
      setBusy(false);
    }
  }

  return (
    <div className="px-2.5 pb-2" data-testid="skill-version-view">
      <div className="flex items-center justify-between gap-3">
        <Button variant="tertiary" size="capsule" className="-ms-3" onClick={onBack}>
          <ChevronLeft aria-hidden="true" className="rtl:-scale-x-100" />
          <Trans>Back</Trans>
        </Button>
        {version && !version.current ? (
          <Button
            variant="tertiary"
            size="capsule"
            disabled={busy}
            className={cn(
              "-me-3 text-destructive hover:text-destructive",
              confirming && "bg-destructive/15",
            )}
            onClick={() => void remove()}
          >
            {confirming ? <Trans>Confirm delete</Trans> : <Trans>Delete</Trans>}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="pt-2 text-meta text-destructive">
          {error}
        </p>
      ) : null}
      {version ? (
        <>
          <div className="px-0.5 pt-2 pb-2">
            <div className="text-row-name text-foreground">{versionDate(version.createdAt)}</div>
            <div className="text-row-status text-muted-foreground">
              {skillVersionSubline(version, words)}
            </div>
          </div>
          <pre
            dir="auto"
            className="rk-scroll max-h-96 overflow-auto rounded-row bg-muted p-3 font-mono text-meta whitespace-pre-wrap text-foreground"
          >
            {version.content}
          </pre>
          {version.files.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-1 px-0.5 font-mono text-meta text-muted-foreground">
              {version.files.map((file) => (
                <li key={file.path} dir="auto" className="truncate">
                  {file.path}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : error ? null : (
        <LoadingRows />
      )}
    </div>
  );
}
