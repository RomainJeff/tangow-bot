import { useLingui } from "@lingui/react/macro";
import type { AvatarStyle, ComputerListItem, SpaceMemoryConfig } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  UserAvatar,
} from "@rakazo/ui-web";
import {
  Brain,
  ChevronsUpDown,
  CloudDownload,
  Cpu,
  Gauge,
  Monitor,
  Signpost,
  SlidersHorizontal,
  UserRound,
  Volume2,
  XIcon,
} from "lucide-react";
import { type ComponentType, useEffect, useId, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { ProfileSettingsPanels, UpdatesSettingsPanel } from "./AccountSettingsOverlay";
import { ComputerSettingsPanel } from "./ComputerSettingsPanel";
import { DecisionModelSettingsPanel } from "./DecisionModelSettingsPanel";
import { MemorySettingsOverlay } from "./MemorySettingsOverlay";
import { ModelSettingsOverlay } from "./ModelSettingsOverlay";
import { SpaceGeneralSettings } from "./SpaceGeneralSettings";
import {
  ACCOUNT_SETTINGS_SECTIONS,
  type SettingsSection,
  SPACE_SETTINGS_SECTIONS,
} from "./settings-sections";
import { UsageSettingsPanel } from "./usage-settings";
import { VoiceSettingsOverlay } from "./VoiceSettingsOverlay";

type NavItem = {
  updateAvailable?: boolean;
  label: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
};

type SettingsSpace = { id: string; name: string };

export function SettingsOverlay({
  email,
  name,
  initials,
  image,
  initialSection = "profile",
  avatarStyle,
  onAvatarStyleChange,
  isDeploymentOwner = false,
  messagingEnabled = false,
  onOpenMessaging,
  memoryConfig,
  onMemoryConfigChange,
  spaces,
  currentSpaceId,
  onSwitchSpace,
  onClose,
  onVoiceStatusMaybeChanged,
}: {
  email?: string | null;
  name: string;
  initials: string;
  image: string | null;
  initialSection?: SettingsSection;
  avatarStyle: AvatarStyle;
  onAvatarStyleChange: (style: AvatarStyle) => Promise<void>;
  isDeploymentOwner?: boolean;
  messagingEnabled?: boolean;
  onOpenMessaging?: () => void;
  memoryConfig: SpaceMemoryConfig | null | undefined;
  onMemoryConfigChange: (config: SpaceMemoryConfig | null) => void;
  spaces: SettingsSpace[];
  currentSpaceId: string | undefined;
  onSwitchSpace: (spaceId: string, section: SettingsSection) => void;
  onClose: () => void;
  onVoiceStatusMaybeChanged?: () => void | Promise<void>;
}) {
  const { t } = useLingui();
  const panelRef = useRef<HTMLDivElement>(null);
  const usageRef = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [decisionModelBusy, setDecisionModelBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [computerUpdateAvailable, setComputerUpdateAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    void rpc.computer
      .list()
      .then((items: ComputerListItem[]) => {
        if (active) setComputerUpdateAvailable(items.some((item) => item.status.updateAvailable));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [section, currentSpaceId]);
  const panelBusy = memoryBusy || decisionModelBusy || voiceBusy;

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    if (section === "usage") {
      usageRef.current?.focus();
    }
  }, [section]);

  const navItems: Record<SettingsSection, NavItem> = {
    profile: { label: t`Profile`, icon: UserRound },
    updates: { label: t`Updates`, icon: CloudDownload },
    space: { label: t`General`, icon: SlidersHorizontal },
    models: { label: t`Models`, icon: Cpu },
    voice: { label: t`Voice`, icon: Volume2 },
    memory: { label: t`Memory`, icon: Brain },
    "decision-model": { label: t`Decision Model`, icon: Signpost },
    computer: { label: t`Computer`, icon: Monitor, updateAvailable: computerUpdateAvailable },
    usage: { label: t`Usage`, icon: Gauge },
  };

  const sectionTitle = navItems[section].label;

  const closeLabel =
    section === "models"
      ? t`Close model settings`
      : section === "memory"
        ? t`Close memory settings`
        : section === "voice"
          ? t`Close voice settings`
          : t`Close user settings`;

  async function refreshVoiceStatus() {
    await onVoiceStatusMaybeChanged?.();
  }

  function leaveSettings(next: () => void) {
    if (panelBusy) return;
    void refreshVoiceStatus().finally(next);
  }

  function requestClose() {
    leaveSettings(onClose);
  }

  const widePane = section === "models" || section === "voice";
  const spaceLabelId = useId();
  const currentSpace = spaces.find((space) => space.id === currentSpaceId);

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (panelBusy) {
          details.cancel();
          return;
        }
        requestClose();
      }}
    >
      <DialogContent
        variant="window"
        ref={panelRef}
        data-testid="user-settings"
        data-settings-section={section}
        showCloseButton={false}
        initialFocus={() =>
          section === "usage" ? (usageRef.current ?? panelRef.current) : panelRef.current
        }
        className={`max-h-[calc(100%-2rem)] sm:max-h-[calc(100%-5rem)] ${
          widePane
            ? "h-[min(760px,calc(100%-2rem))] w-[min(1080px,calc(100%-2rem))] sm:max-w-[1080px]"
            : "h-[min(720px,calc(100%-2rem))] w-[min(920px,calc(100%-2rem))] sm:max-w-[920px]"
        }`}
      >
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav
            data-testid="settings-nav"
            aria-label={t`Settings`}
            // Beside the content, an inset panel like the app's sidebar; at phone width a row of tabs.
            className="flex shrink-0 flex-row gap-1 overflow-x-auto px-3 py-3 md:m-2 md:w-[200px] md:flex-col md:gap-0.5 md:overflow-y-auto md:rounded-xl md:bg-group md:p-2 md:shadow-group"
          >
            <div className="flex items-center gap-2.5 px-2.5 pt-1.5 pb-2.5 max-md:hidden">
              <UserAvatar initials={initials} image={image} className="size-6 text-label" />
              <span className="truncate text-row-name font-semibold text-foreground">{name}</span>
            </div>
            {ACCOUNT_SETTINGS_SECTIONS.map((id) => (
              <SettingsNavButton
                key={id}
                id={id}
                item={navItems[id]}
                active={id === section}
                disabled={panelBusy}
                onSelect={setSection}
              />
            ))}
            <div
              aria-hidden="true"
              className="shrink-0 bg-border max-md:mx-1 max-md:w-px md:mx-1 md:my-2 md:h-px"
            />
            <SpaceSwitcher
              labelId={spaceLabelId}
              spaces={spaces}
              currentSpaceId={currentSpaceId}
              disabled={panelBusy}
              onSwitch={(spaceId) => {
                if (panelBusy) return;
                onSwitchSpace(spaceId, section);
              }}
            />
            <fieldset
              aria-labelledby={currentSpace ? spaceLabelId : undefined}
              className="contents"
            >
              {SPACE_SETTINGS_SECTIONS.map((id) => (
                <SettingsNavButton
                  key={id}
                  id={id}
                  item={navItems[id]}
                  active={id === section}
                  disabled={panelBusy}
                  onSelect={setSection}
                />
              ))}
            </fieldset>
          </nav>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex items-start justify-between gap-4 px-6 pt-6 sm:px-8 sm:pt-7">
              <DialogTitle className="text-2xl font-medium text-foreground">
                {sectionTitle}
              </DialogTitle>
              <DialogClose
                aria-label={closeLabel}
                disabled={panelBusy}
                render={<Button variant="ghost" size="icon-sm" />}
              >
                <XIcon />
              </DialogClose>
            </div>

            <div
              className={`min-h-0 flex-1 ${
                section === "models" ||
                section === "voice" ||
                section === "memory" ||
                section === "decision-model"
                  ? "flex flex-col overflow-hidden"
                  : "rk-scroll overflow-y-auto overscroll-contain px-6 pb-6 pt-5 sm:px-8 sm:pb-8"
              }`}
            >
              {section === "profile" ? (
                <ProfileSettingsPanels
                  email={email}
                  name={name}
                  initials={initials}
                  avatarStyle={avatarStyle}
                  onAvatarStyleChange={onAvatarStyleChange}
                  isDeploymentOwner={isDeploymentOwner}
                />
              ) : null}
              {section === "space" ? (
                <SpaceGeneralSettings
                  messagingEnabled={messagingEnabled}
                  onOpenMessaging={
                    onOpenMessaging ? () => leaveSettings(onOpenMessaging) : undefined
                  }
                />
              ) : null}
              {section === "usage" ? <UsageSettingsPanel panelRef={usageRef} /> : null}
              {section === "computer" ? (
                <ComputerSettingsPanel onUpdateAvailableChange={setComputerUpdateAvailable} />
              ) : null}
              {section === "updates" ? (
                <UpdatesSettingsPanel isDeploymentOwner={isDeploymentOwner} />
              ) : null}
              {section === "models" ? (
                <ModelSettingsOverlay embedded onClose={requestClose} />
              ) : null}
              {section === "memory" ? (
                <MemorySettingsOverlay
                  embedded
                  onClose={requestClose}
                  config={memoryConfig}
                  onConfigChange={onMemoryConfigChange}
                  onBusyChange={setMemoryBusy}
                />
              ) : null}
              {section === "decision-model" ? (
                <DecisionModelSettingsPanel onBusyChange={setDecisionModelBusy} />
              ) : null}
              {section === "voice" ? (
                <VoiceSettingsOverlay embedded onClose={requestClose} onBusyChange={setVoiceBusy} />
              ) : null}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SettingsNavButton({
  id,
  item,
  active,
  disabled,
  onSelect,
}: {
  id: SettingsSection;
  item: NavItem;
  active: boolean;
  disabled: boolean;
  onSelect: (section: SettingsSection) => void;
}) {
  const { t } = useLingui();
  const Icon = item.icon;
  return (
    <button
      type="button"
      data-testid={`settings-nav-${id}`}
      aria-current={active ? "page" : undefined}
      disabled={disabled}
      onClick={() => onSelect(id)}
      className={`flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13.5px] transition-colors disabled:pointer-events-none disabled:opacity-50 ${
        active
          ? "bg-sidebar-accent text-foreground max-md:bg-group max-md:shadow-group"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
      }`}
    >
      <Icon className="size-4 shrink-0" strokeWidth={1.75} />
      <span className="whitespace-nowrap">{item.label}</span>
      {item.updateAvailable ? (
        <span role="img" aria-label={t`Update available`} title={t`Update available`}>
          <CloudDownload className="size-4 shrink-0" aria-hidden />
        </span>
      ) : null}
    </button>
  );
}

function SpaceTile({ name, current }: { name: string; current: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`grid size-5.5 shrink-0 place-items-center rounded-chip text-label ${
        current ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
      }`}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Names the space the group below edits, and switches it when there is more than one. */
function SpaceSwitcher({
  labelId,
  spaces,
  currentSpaceId,
  disabled,
  onSwitch,
}: {
  labelId: string;
  spaces: SettingsSpace[];
  currentSpaceId: string | undefined;
  disabled: boolean;
  onSwitch: (spaceId: string) => void;
}) {
  const { t } = useLingui();
  const current = spaces.find((space) => space.id === currentSpaceId);
  if (!current) return null;
  const label = (
    <>
      <SpaceTile name={current.name} current />
      <span id={labelId} className="min-w-0 flex-1 truncate text-start text-row-name font-semibold">
        {current.name}
      </span>
    </>
  );
  if (spaces.length < 2) {
    return (
      <div
        data-testid="settings-space-label"
        className="flex shrink-0 items-center gap-2.5 px-2.5 py-2 text-foreground"
      >
        {label}
      </div>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="settings-space-switcher"
        aria-label={t`Switch space`}
        disabled={disabled}
        className="flex shrink-0 items-center gap-2.5 rounded-row bg-muted px-2.5 py-2 text-foreground transition-colors hover:bg-sidebar-accent disabled:pointer-events-none disabled:opacity-50 data-popup-open:bg-sidebar-accent md:mb-1"
      >
        {label}
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60" data-testid="settings-space-menu">
        <DropdownMenuRadioGroup
          value={current.id}
          onValueChange={(spaceId: string) => {
            if (spaceId !== current.id) onSwitch(spaceId);
          }}
        >
          {spaces.map((space) => (
            <DropdownMenuRadioItem key={space.id} value={space.id} className="gap-2.5 py-1.5">
              <SpaceTile name={space.name} current={space.id === current.id} />
              <span className="truncate text-row-name">{space.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
