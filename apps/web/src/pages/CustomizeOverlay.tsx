import { Trans, useLingui } from "@lingui/react/macro";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@tangow/ui-web";
import { Puzzle, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { PluginsOverlay } from "./PluginsOverlay";
import { SkillsOverlay } from "./SkillsOverlay";

export type CustomizeSection = "integrations" | "skills";

/** Left rail of the Customize overlay: one entry per section. */
function CustomizeNav({
  section,
  onSelect,
}: {
  section: CustomizeSection;
  onSelect: (section: CustomizeSection) => void;
}) {
  const { t } = useLingui();
  const items = [
    { id: "integrations" as const, label: <Trans>Integrations</Trans>, Icon: Puzzle },
    { id: "skills" as const, label: <Trans>Skills</Trans>, Icon: Sparkles },
  ];
  return (
    <nav
      aria-label={t`Customize`}
      className="flex shrink-0 flex-row gap-1 overflow-x-auto px-3 py-3 md:m-2 md:w-56 md:flex-col md:rounded-xl md:bg-group md:p-2 md:pt-5 md:shadow-group"
    >
      <div className="hidden px-2.5 pb-4 text-2xl text-foreground md:block">
        <Trans>Customize</Trans>
      </div>
      {items.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          data-testid={`customize-nav-${id}`}
          aria-current={section === id ? "page" : undefined}
          onClick={() => onSelect(id)}
          className={`flex shrink-0 items-center gap-2.5 rounded-[11px] px-2.5 py-2 text-start text-[14.5px] ${
            section === id
              ? "bg-sidebar-accent font-medium text-foreground max-md:bg-group max-md:shadow-group"
              : "text-foreground/80 hover:bg-sidebar-accent/60"
          }`}
        >
          <Icon size={15} strokeWidth={1.7} className="shrink-0" />
          {label}
        </button>
      ))}
    </nav>
  );
}

/**
 * Single entry point for the space-level panels the sidebar used to open one by
 * one. One dialog hosts every section so switching never closes and reopens it;
 * a visited section stays mounted so coming back neither reloads nor resets it.
 */
export function CustomizeOverlay({
  activeBotId,
  onClose,
  onOpenMcp,
  onSkillsChanged,
}: {
  activeBotId?: string;
  onClose: () => void;
  onOpenMcp?: () => void;
  onSkillsChanged?: () => void;
}) {
  const { t } = useLingui();
  const [section, setSection] = useState<CustomizeSection>("integrations");
  const [skillsVisited, setSkillsVisited] = useState(false);
  const sectionClass = (id: CustomizeSection) =>
    section === id ? "flex min-h-0 flex-1 flex-col" : "hidden";

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
        <CustomizeNav
          section={section}
          onSelect={(next) => {
            setSection(next);
            if (next === "skills") setSkillsVisited(true);
          }}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DialogHeader className="flex-row items-start justify-between px-8 pt-7">
            <DialogTitle className="text-2xl text-foreground">
              {section === "integrations" ? <Trans>Integrations</Trans> : <Trans>Skills</Trans>}
            </DialogTitle>
            <DialogClose
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={section === "integrations" ? t`Close integrations` : t`Close skills`}
                />
              }
            >
              <X />
            </DialogClose>
          </DialogHeader>
          <div className={sectionClass("integrations")}>
            <PluginsOverlay activeBotId={activeBotId} onOpenMcp={onOpenMcp} />
          </div>
          {skillsVisited ? (
            <div className={sectionClass("skills")}>
              <SkillsOverlay botId={activeBotId} onSkillsChanged={onSkillsChanged} />
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
