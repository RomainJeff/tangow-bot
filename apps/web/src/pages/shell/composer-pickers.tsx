import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { AgentSkillCatalogEntry } from "@tangow/contracts";
import type { ComposerMention, SlashActionId } from "@tangow/core";
import {
  clampMentionHighlightIndex,
  mentionChipKey,
  SLASH_ACTIONS,
  slashSkillOptions as slashSkills,
  truncateSlashDescription,
} from "@tangow/core";
import { BotAvatar } from "@tangow/ui-web";
import { Box, Clock, Puzzle, Settings, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";

/** The `@` and `/` pickers: what the draft is asking for and what they offer for it. */
export function useComposerPickers({
  mentionTargets,
  agentSkills,
  onSlashOpen,
  chatSettings = true,
}: {
  mentionTargets?: ComposerMention[];
  agentSkills?: AgentSkillCatalogEntry[];
  onSlashOpen?: () => void;
  /** False in a thread with a bot shared with you, whose settings are its owner's. */
  chatSettings?: boolean;
}) {
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionHighlightIndex, setMentionHighlightIndex] = useState(0);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const mentionListboxId = useId();

  /** Reads the edited draft for a trailing `@query` or a leading `/query`. */
  function trackDraft(value: string, slashAllowed: boolean) {
    const mentionMatch = /(?:^|\s)@([\w-]*)$/.exec(value);
    setMentionQuery(mentionMatch ? (mentionMatch[1] ?? "") : null);
    // `/` only at the start of the draft so forced skills expand (`Use skill:` / `/Name` prefix).
    const slashMatch = slashAllowed ? /^\/([^\n]*)$/.exec(value) : null;
    const nextSlash = slashMatch ? (slashMatch[1] ?? "") : null;
    if (nextSlash !== null && slashQuery === null) onSlashOpen?.();
    setSlashQuery(nextSlash);
  }

  function closeMentions() {
    setMentionQuery(null);
    setMentionHighlightIndex(0);
  }

  function closeSlash() {
    setSlashQuery(null);
  }

  function closeAll() {
    closeMentions();
    closeSlash();
  }

  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || !mentionTargets?.length) return [];
    const query = mentionQuery.trim().toLowerCase();
    return mentionTargets
      .filter((target) => !query || target.name.toLowerCase().startsWith(query))
      .slice(0, 10);
  }, [mentionQuery, mentionTargets]);

  useEffect(() => {
    setMentionHighlightIndex(0);
  }, [mentionQuery, mentionOptions]);

  const activeMentionIndex = clampMentionHighlightIndex(
    mentionHighlightIndex,
    mentionOptions.length,
  );
  const mentionPickerOpen = mentionOptions.length > 0;
  const activeMentionOptionId = mentionPickerOpen
    ? `${mentionListboxId}-option-${activeMentionIndex}`
    : undefined;

  const slashSkillOptions = useMemo(
    () => (slashQuery === null ? [] : slashSkills(agentSkills ?? [], slashQuery)),
    [agentSkills, slashQuery],
  );

  const slashActionOptions = useMemo(() => {
    if (slashQuery === null) return [];
    const query = slashQuery.trim().toLowerCase();
    // The picker shows each action under its own label, so a search matches that label too.
    return SLASH_ACTIONS.filter(
      (action) =>
        (chatSettings || action.id !== "chat-settings") &&
        (!query ||
          action.label.toLowerCase().includes(query) ||
          slashActionLabel(action.id).toLowerCase().includes(query)),
    );
  }, [slashQuery, chatSettings]);

  const showSlashPicker =
    slashQuery !== null &&
    mentionQuery === null &&
    (slashSkillOptions.length > 0 || slashActionOptions.length > 0);

  return {
    trackDraft,
    closeMentions,
    closeSlash,
    closeAll,
    setMentionHighlightIndex,
    mentionListboxId,
    mentionOptions,
    activeMentionIndex,
    mentionPickerOpen,
    activeMentionOptionId,
    slashSkillOptions,
    slashActionOptions,
    showSlashPicker,
  };
}

export function MentionPicker({
  id,
  options,
  activeIndex,
  onPick,
  onHighlight,
}: {
  id: string;
  options: ComposerMention[];
  activeIndex: number;
  onPick: (mention: ComposerMention) => void;
  onHighlight: (index: number) => void;
}) {
  const { t } = useLingui();
  return (
    <div
      id={id}
      role="listbox"
      aria-label={t`Mentions`}
      data-testid="mention-picker"
      className="mb-2 overflow-hidden rounded-card border border-border bg-muted"
    >
      {options.map((mention, index) => {
        const optionId = `${id}-option-${index}`;
        const highlighted = index === activeIndex;
        return (
          <button
            id={optionId}
            key={mentionChipKey(mention)}
            type="button"
            role="option"
            aria-selected={highlighted}
            aria-label={t`@${mention.name}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(mention)}
            onMouseEnter={() => onHighlight(index)}
            className={`flex w-full items-start gap-3 px-4 py-2.5 text-start hover:bg-accent ${
              highlighted ? "bg-accent" : ""
            }`}
          >
            <MentionOptionIcon mention={mention} />
            <span className="min-w-0">
              <span dir="auto" className="block text-capsule text-foreground">
                @{mention.name}
              </span>
              {mention.subtitle ? (
                <span dir="auto" className="block truncate text-label text-muted-foreground">
                  {mention.subtitle}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function SlashPicker({
  skills,
  actions,
  onSkill,
  onAction,
}: {
  skills: AgentSkillCatalogEntry[];
  actions: readonly { id: SlashActionId }[];
  onSkill: (skill: AgentSkillCatalogEntry) => void;
  onAction: (action: SlashActionId) => void;
}) {
  const { t } = useLingui();
  return (
    <div
      data-testid="slash-picker"
      className="mb-2 overflow-hidden rounded-card border border-border bg-muted"
    >
      {skills.map((skill) => (
        <button
          key={skill.id}
          type="button"
          aria-label={t`Skill ${skill.name}`}
          onClick={() => onSkill(skill)}
          className="flex w-full items-start gap-3 px-4 py-2.5 text-start hover:bg-accent"
        >
          <Box size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span dir="auto" className="block text-capsule text-foreground">
              {skill.name}
            </span>
            <span dir="auto" className="block truncate text-label text-muted-foreground">
              {truncateSlashDescription(skill.description)}
            </span>
          </span>
        </button>
      ))}
      {actions.map((action) => {
        const label = slashActionLabel(action.id);
        return (
          <button
            key={action.id}
            type="button"
            aria-label={label}
            onClick={() => onAction(action.id)}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-accent"
          >
            <Settings size={16} strokeWidth={1.7} className="shrink-0 text-muted-foreground" />
            <span className="text-capsule text-foreground">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The skill and mention chips picked into the draft. */
export function SelectedChips({
  skill,
  mentions,
  disabled,
  onRemoveSkill,
  onRemoveMention,
}: {
  skill: AgentSkillCatalogEntry | null;
  mentions: ComposerMention[];
  disabled: boolean;
  onRemoveSkill: () => void;
  onRemoveMention: (mention: ComposerMention) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {skill ? (
        <span
          data-testid="skill-chip"
          className="inline-flex h-7.5 max-w-full items-center gap-1.5 rounded-full bg-accent ps-2.5 pe-2.5 text-capsule text-foreground"
        >
          <Box size={13} strokeWidth={1.7} className="shrink-0 text-muted-foreground/70" />
          <span dir="auto" className="truncate">
            {skill.name}
          </span>
          <button
            type="button"
            aria-label={t`Remove skill ${skill.name}`}
            onClick={onRemoveSkill}
            disabled={disabled}
            className="text-muted-foreground hover:text-foreground disabled:pointer-events-none"
          >
            <X size={12} strokeWidth={2} />
          </button>
        </span>
      ) : null}
      {mentions.map((mention) => (
        <span
          key={mentionChipKey(mention)}
          data-testid="mention-chip"
          data-mention-kind={mention.kind}
          className="inline-flex h-7.5 max-w-full items-center gap-1.5 rounded-full bg-mention-chip ps-1.25 pe-2.5 text-capsule text-mention-chip-foreground"
        >
          <MentionChipIcon mention={mention} />
          <span dir="auto" className="truncate">
            {mention.name}
          </span>
          <button
            type="button"
            aria-label={t`Remove mention ${mention.name}`}
            onClick={() => onRemoveMention(mention)}
            disabled={disabled}
            className="text-muted-foreground hover:text-foreground disabled:pointer-events-none"
          >
            <X size={12} strokeWidth={2} />
          </button>
        </span>
      ))}
    </div>
  );
}

function slashActionLabel(id: SlashActionId) {
  switch (id) {
    case "chat-settings":
      return t`Bot settings`;
    case "settings-general":
      return t`Settings: General`;
    case "settings-usage":
      return t`Settings: Usage`;
  }
}

function MentionOptionIcon({ mention }: { mention: ComposerMention }) {
  if (mention.kind === "routine") {
    return <Clock size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-muted-foreground" />;
  }
  if (mention.kind === "connector") {
    return <Puzzle size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-muted-foreground" />;
  }
  if (mention.kind === "group") {
    return (
      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent text-[9px] text-foreground/75">
        G
      </span>
    );
  }
  if (mention.kind === "everyone") {
    return (
      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent text-[9px] text-foreground/75">
        @
      </span>
    );
  }
  return <BotAvatar character={mention.avatarCharacter} size={16} />;
}

/** The 18 px avatar sized for the Quiet mention chip (see docs/design-system.md). */
function MentionChipIcon({ mention }: { mention: ComposerMention }) {
  if (mention.kind === "routine") {
    return <Clock size={13} strokeWidth={1.7} className="shrink-0 text-muted-foreground/70" />;
  }
  if (mention.kind === "connector") {
    return <Puzzle size={13} strokeWidth={1.7} className="shrink-0 text-muted-foreground/70" />;
  }
  if (mention.kind === "group" || mention.kind === "everyone") {
    return (
      <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent text-[9px] text-foreground/75">
        {mention.kind === "group" ? "G" : "@"}
      </span>
    );
  }
  return <BotAvatar character={mention.avatarCharacter} size={18} />;
}
