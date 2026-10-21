import { Trans, useLingui } from "@lingui/react/macro";
import { Puzzle, Sparkles } from "lucide-react";
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
 * one. Each section keeps its own dialog shell and renders the shared rail.
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
  const [section, setSection] = useState<CustomizeSection>("integrations");
  // ponytail: switching sections remounts the dialog, which also resets the
  // section's own state. Hoist state into here if that ever gets annoying.
  const nav = <CustomizeNav section={section} onSelect={setSection} />;

  return section === "integrations" ? (
    <PluginsOverlay
      sidebar={nav}
      activeBotId={activeBotId}
      onClose={onClose}
      onOpenMcp={onOpenMcp}
    />
  ) : (
    <SkillsOverlay
      sidebar={nav}
      botId={activeBotId}
      onClose={onClose}
      onSkillsChanged={onSkillsChanged}
    />
  );
}
