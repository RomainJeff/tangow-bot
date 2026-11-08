import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { ApprovalRulesSettings } from "../components/ApprovalRulesSettings";
import { rpc } from "../lib/rpc";

type GeneralSpace = { id: string; name: string; canRename?: boolean };

export function SpaceGeneralSettings({
  space,
  onSpaceRenamed,
  messagingEnabled = false,
  onOpenMessaging,
}: {
  space?: GeneralSpace;
  onSpaceRenamed?: () => void | Promise<void>;
  messagingEnabled?: boolean;
  onOpenMessaging?: () => void;
}) {
  return (
    <div className="space-y-5">
      {space ? <SpaceNameRow key={space.id} space={space} onRenamed={onSpaceRenamed} /> : null}

      {messagingEnabled && onOpenMessaging ? (
        <section className="rounded-card bg-group shadow-group px-4 py-4">
          <h3 className="text-[15px] font-medium text-foreground">
            <Trans>Messaging</Trans>
          </h3>
          <p className="mt-3 text-[13px] text-muted-foreground/70">
            <Trans>Chat apps, group channels, and agent connections.</Trans>
          </p>
          <Button variant="secondary" className="mt-3 rounded-full" onClick={onOpenMessaging}>
            <Trans>Manage messaging settings</Trans>
          </Button>
        </section>
      ) : null}

      <details data-testid="advanced-settings" className="group rounded-card bg-group shadow-group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-4 text-[14px] text-foreground/75">
          <span>
            <span className="block text-[15px] text-foreground">
              <Trans>Advanced</Trans>
            </span>
            <span className="mt-1 block text-[12.5px] text-muted-foreground/80">
              <Trans>Optional controls most people never need</Trans>
            </span>
          </span>
          <span aria-hidden="true" className="transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        <div className="border-t border-border px-4 pb-5">
          <ApprovalRulesSettings />
        </div>
      </details>
    </div>
  );
}

/** Saves on blur or Enter; an empty or unchanged name puts the saved one back. */
function SpaceNameRow({
  space,
  onRenamed,
}: {
  space: GeneralSpace;
  onRenamed?: () => void | Promise<void>;
}) {
  const { t } = useLingui();
  const inputId = useId();
  const [value, setValue] = useState(space.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(space.name);
  }, [space.name]);

  async function commit() {
    const name = value.trim();
    if (!name || name === space.name) {
      setValue(space.name);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await rpc.spaces.rename({ spaceId: space.id, name });
    } catch {
      setValue(space.name);
      setError(t`Couldn't rename the space`);
      return;
    } finally {
      setPending(false);
    }
    setValue(name);
    await onRenamed?.();
  }

  return (
    <section className="rounded-card bg-group shadow-group px-4 py-3">
      <div className="flex min-h-9 items-center justify-between gap-4">
        <label
          htmlFor={space.canRename ? inputId : undefined}
          className="text-row-name text-foreground"
        >
          <Trans>Name</Trans>
        </label>
        {space.canRename ? (
          <Input
            id={inputId}
            data-testid="space-name-input"
            value={value}
            maxLength={60}
            disabled={pending}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="max-w-65"
          />
        ) : (
          <span className="min-w-0 truncate text-row-name text-muted-foreground">{space.name}</span>
        )}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
