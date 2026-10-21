import { Trans, useLingui } from "@lingui/react/macro";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@rakazo/ui-web";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { AgentSkills } from "./KnowledgeSection";

/** Runtime ceiling: the agent only sees the first 50 visible skills. */
const SKILL_LIMIT = 50;

export function SkillsOverlay({
  onClose,
  botId,
  onSkillsChanged,
  sidebar,
}: {
  onClose: () => void;
  botId?: string;
  onSkillsChanged?: () => void;
  sidebar?: ReactNode;
}) {
  const { t } = useLingui();
  const [visibleCount, setVisibleCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadCatalog() {
    setVisibleCount((await rpc.agentSkills.list({ botId })).length);
  }

  useEffect(() => {
    void loadCatalog().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : t`Could not load skills`),
    );
  }, [botId]);

  function afterMutation() {
    onSkillsChanged?.();
    void loadCatalog().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : t`Could not load skills`),
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        variant="window"
        showCloseButton={false}
        className="flex h-[760px] max-h-[calc(100%-2rem)] w-[min(1080px,calc(100%-2rem))] max-w-[calc(100%-2rem)] flex-row gap-0 overflow-hidden p-0 max-md:flex-col sm:max-w-[1080px]"
      >
        {sidebar}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DialogHeader className="flex-row items-start justify-between px-8 pt-7">
            <DialogTitle className="text-2xl text-foreground">
              <Trans>Skills</Trans>
            </DialogTitle>
            <DialogClose
              render={<Button variant="ghost" size="icon-sm" aria-label={t`Close skills`} />}
            >
              <X />
            </DialogClose>
          </DialogHeader>

          <div className="rk-scroll flex-1 overflow-y-auto px-8 py-6">
            {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}

            {visibleCount !== null && visibleCount > SKILL_LIMIT ? (
              <p className="mb-3 text-[13px] text-destructive">
                <Trans>Only the first 50 skills are shown to the agent.</Trans>
              </p>
            ) : null}
            <AgentSkills onChanged={afterMutation} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
