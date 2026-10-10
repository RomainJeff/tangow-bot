import { Trans, useLingui } from "@lingui/react/macro";
import type { TrashedSkill } from "@rakazo/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  SettingRow,
} from "@rakazo/ui-web";
import { Ellipsis } from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { useVersionDate } from "./SkillVersions";
import { refusalMessage } from "./skill-versions";

export type RestoredSkill = { skillId: string; name: string; botGone: boolean };

/**
 * The skills deleted in the last 30 days, in a row that exists only while there is one. A skill
 * comes back with Undo; Delete now erases it at once, after a second press.
 */
export function RecentlyDeleted({
  open: openOnMount = false,
  reloadKey,
  onRestored,
}: {
  open?: boolean;
  /** Changes when the skills list was read again, which may have emptied or filled the trash. */
  reloadKey: number;
  onRestored: (restored: RestoredSkill) => Promise<void>;
}) {
  const { t } = useLingui();
  const versionDate = useVersionDate();
  const [trash, setTrash] = useState<TrashedSkill[]>([]);
  const [open, setOpen] = useState(openOnMount);
  const [purging, setPurging] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTrash(await rpc.agentSkills.trash({}));
    } catch {
      setTrash([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  useEffect(() => {
    if (openOnMount) setOpen(true);
  }, [openOnMount]);

  async function restore(entry: TrashedSkill) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const restored = await rpc.agentSkills.restore({ uid: entry.uid });
      setTrash((list) => list.filter((item) => item.uid !== entry.uid));
      await onRestored(restored);
    } catch (failure) {
      setError(refusalMessage(failure) ?? t`Could not restore`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function purge(entry: TrashedSkill) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.agentSkills.purge({ uid: entry.uid });
      setTrash((list) => list.filter((item) => item.uid !== entry.uid));
    } catch (failure) {
      setError(refusalMessage(failure) ?? t`Could not delete`);
      await load();
    } finally {
      setPurging(null);
      setBusy(false);
    }
  }

  if (trash.length === 0) return null;
  return (
    <section className="mt-2 flex flex-col gap-1" data-testid="skills-trash">
      <SettingRow
        label={<Trans>Recently deleted</Trans>}
        expanded={open}
        onClick={() => setOpen((value) => !value)}
      />
      {open ? (
        <>
          {error ? (
            <p role="alert" className="mx-3.5 text-meta text-destructive">
              {error}
            </p>
          ) : null}
          <div>
            {trash.map((entry, index) => (
              <Fragment key={entry.uid}>
                {index > 0 ? <div aria-hidden className="mx-3 h-px bg-border" /> : null}
                <SettingRow
                  label={<span dir="auto">{entry.name}</span>}
                  subline={versionDate(entry.trashedAt)}
                  data-testid="skills-trash-row"
                >
                  {purging === entry.uid ? (
                    <span className="flex items-center gap-1">
                      <Button
                        variant="quickReply"
                        size="quickReply"
                        disabled={busy}
                        className="text-destructive"
                        onClick={() => void purge(entry)}
                      >
                        <Trans>Confirm delete</Trans>
                      </Button>
                      <Button variant="tertiary" size="quickReply" onClick={() => setPurging(null)}>
                        <Trans>Cancel</Trans>
                      </Button>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <Button
                        variant="quickReply"
                        size="quickReply"
                        disabled={busy}
                        onClick={() => void restore(entry)}
                      >
                        <Trans>Undo</Trans>
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button variant="roundIcon" size="roundIconSm" aria-label={t`More`} />
                          }
                        >
                          <Ellipsis aria-hidden="true" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-40">
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setPurging(entry.uid)}
                          >
                            <Trans>Delete now</Trans>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </span>
                  )}
                </SettingRow>
              </Fragment>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
