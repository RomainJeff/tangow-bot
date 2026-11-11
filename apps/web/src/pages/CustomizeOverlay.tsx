import { Trans, useLingui } from "@lingui/react/macro";
import {
  Button,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  SettingRow,
} from "@tangow/ui-web";
import { Puzzle, Sparkles, X } from "lucide-react";
import { useRef, useState } from "react";
import { useMediaQuery } from "../lib/use-media-query";
import { BackCapsule } from "./BackCapsule";
import { SettingsGroup } from "./bot-page/page-kit";
import { PluginsOverlay } from "./PluginsOverlay";
import { SkillsOverlay } from "./SkillsOverlay";
import { PHONE_MEDIA } from "./shell/layout";
import { usePushedFocus } from "./use-pushed-focus";

export type CustomizeSection = "integrations" | "skills";

const CUSTOMIZE_ITEMS = [
  { id: "integrations" as const, label: <Trans>Integrations</Trans>, Icon: Puzzle },
  { id: "skills" as const, label: <Trans>Skills</Trans>, Icon: Sparkles },
];

/** Left rail of the Customize overlay: one entry per section. */
function CustomizeNav({
  section,
  onSelect,
}: {
  section: CustomizeSection;
  onSelect: (section: CustomizeSection) => void;
}) {
  const { t } = useLingui();
  return (
    <nav
      aria-label={t`Customize`}
      className="m-2 flex w-56 shrink-0 flex-col gap-1 rounded-xl bg-group p-2 pt-5 shadow-group"
    >
      <div className="px-2.5 pb-4 text-2xl text-foreground">
        <Trans>Customize</Trans>
      </div>
      {CUSTOMIZE_ITEMS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          data-testid={`customize-nav-${id}`}
          aria-current={section === id ? "page" : undefined}
          onClick={() => onSelect(id)}
          className={`flex shrink-0 items-center gap-2.5 rounded-[11px] px-2.5 py-2 text-start text-[14.5px] ${
            section === id
              ? "bg-sidebar-accent font-medium text-foreground"
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

/** At phone width the sections are a list the person picks from. */
function CustomizeList({ onSelect }: { onSelect: (section: CustomizeSection) => void }) {
  return (
    <div className="px-8 pt-5">
      <SettingsGroup>
        {CUSTOMIZE_ITEMS.map(({ id, label, Icon }) => (
          <SettingRow
            key={id}
            data-testid={`customize-list-${id}`}
            data-opens={id}
            leading={<Icon className="size-4 text-muted-foreground" strokeWidth={1.75} />}
            label={label}
            chevron
            onClick={() => onSelect(id)}
          />
        ))}
      </SettingsGroup>
    </div>
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
  const phone = useMediaQuery(PHONE_MEDIA);
  const [chosen, setChosen] = useState<CustomizeSection | null>(phone ? null : "integrations");
  // A phone shows the list of sections until one is chosen; a window always shows one.
  const section = phone ? chosen : (chosen ?? "integrations");
  const panelRef = useRef<HTMLDivElement>(null);
  const back = usePushedFocus(section, panelRef);
  const [skillsVisited, setSkillsVisited] = useState(false);
  const selectSection = (next: CustomizeSection) => {
    setChosen(next);
    if (next === "skills") setSkillsVisited(true);
  };
  const sectionClass = (id: CustomizeSection) =>
    section === id ? "flex min-h-0 flex-1 flex-col" : "hidden";

  const closeButton = (
    <DialogClose
      render={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={
            section === "integrations"
              ? t`Close integrations`
              : section === "skills"
                ? t`Close skills`
                : t`Close`
          }
        />
      }
    >
      <X />
    </DialogClose>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        variant="window"
        ref={panelRef}
        showCloseButton={false}
        className="flex h-[760px] max-h-[calc(100%-2rem)] w-[min(1080px,calc(100%-2rem))] max-w-[calc(100%-2rem)] flex-row gap-0 overflow-hidden p-0 max-md:flex-col sm:max-w-[1080px]"
      >
        {section && !phone ? <CustomizeNav section={section} onSelect={selectSection} /> : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {phone ? (
            <div
              className={cn(
                "box-content flex h-capsule shrink-0 items-center justify-between gap-1 px-2.5 pt-2.5",
                !section && "justify-end",
              )}
            >
              {section ? (
                <BackCapsule ref={back} label={t`Customize`} onClick={() => setChosen(null)} />
              ) : null}
              {closeButton}
            </div>
          ) : null}
          <DialogHeader className="flex-row items-start justify-between px-8 pt-7">
            <DialogTitle className="text-2xl text-foreground">
              {section === null ? (
                <Trans>Customize</Trans>
              ) : section === "integrations" ? (
                <Trans>Integrations</Trans>
              ) : (
                <Trans>Skills</Trans>
              )}
            </DialogTitle>
            {phone ? null : closeButton}
          </DialogHeader>
          {section === null ? <CustomizeList onSelect={selectSection} /> : null}
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
