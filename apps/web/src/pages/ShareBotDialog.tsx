import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AgentSkillCatalogEntry,
  Bot,
  BotConnector,
  BotSharing,
  Connection,
  ConnectionCatalogItem,
  SpaceMembers,
} from "@rakazo/contracts";
import {
  Checkbox,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  SettingRow,
  Switch,
  UserAvatar,
} from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { saveFailureReason } from "../lib/save-store";
import { userInitials } from "../lib/user-initials";
import { SettingsGroup } from "./bot-page/page-kit";

/** The owner's own skills a bot can be given; a disabled one is given to no bot. */
const givable = (skills: AgentSkillCatalogEntry[]) =>
  skills.filter((skill) => skill.source === "user" && skill.availability !== "disabled");

type App = { key: string; name: string; need: BotConnector };
const appKey = (app: { connectorId: string; provider: string }) =>
  `${app.connectorId}:${app.provider}`;

/** The owner's connected apps, one per app however many accounts, named as in the catalog. */
function connectedApps(rows: Connection[], catalog: ConnectionCatalogItem[]): App[] {
  const apps = new Map<string, App>();
  for (const row of rows) {
    if (row.status !== "connected" || apps.has(appKey(row))) continue;
    const item = catalog.find(
      (entry) => entry.connectorId === row.connectorId && entry.slug === row.provider,
    );
    apps.set(appKey(row), {
      key: appKey(row),
      name: item?.name ?? row.displayName,
      need: { kind: "app", connectorId: row.connectorId, provider: row.provider },
    });
  }
  return [...apps.values()];
}

/**
 * Who besides its owner uses the bot: everyone in the Space, or the people ticked. Each change
 * saves itself; no one ticked means only the owner. Once shared, the bot uses only the skills
 * ticked for it, and a member's run only the apps ticked, with the member's own accounts.
 */
export function ShareBotDialog({
  bot,
  spaceName,
  userId,
  onClose,
}: {
  bot: Pick<Bot, "id" | "name" | "spaceId">;
  spaceName: string;
  userId: string;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [sharing, setSharing] = useState<BotSharing | null>(null);
  const [people, setPeople] = useState<SpaceMembers["members"]>([]);
  const [skills, setSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const [apps, setApps] = useState<App[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([
      rpc.bots.sharing({ botId: bot.id }),
      rpc.spaces.members({ spaceId: bot.spaceId }),
      rpc.agentSkills.list(),
    ]).then(
      ([current, view, catalog]) => {
        if (!live) return;
        setSharing(current);
        setPeople(view.members.filter((member) => member.userId !== userId));
        setSkills(givable(catalog));
      },
      () => live && setError(t`Couldn't load`),
    );
    // The catalog only names the apps, and can be slow: the sheet doesn't wait for it.
    Promise.all([
      rpc.connections.list(),
      rpc.connections.catalog({}).catch(() => [] as ConnectionCatalogItem[]),
    ]).then(
      ([rows, catalog]) => live && setApps(connectedApps(rows, catalog)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [bot.id, bot.spaceId, userId, t]);

  async function save(
    next: Omit<BotSharing, "connectors"> & Partial<Pick<BotSharing, "connectors">>,
  ) {
    const previous = sharing;
    setSharing(previous && { ...previous, ...next });
    setPending(true);
    setError(null);
    try {
      setSharing(await rpc.bots.share({ botId: bot.id, ...next }));
      // Sharing changes which skills count for the bot.
      setSkills(givable(await rpc.agentSkills.list()));
    } catch (failure) {
      setSharing(previous);
      // A refusal the API explains, such as a bot still running, says why.
      setError(saveFailureReason(failure) || t`Couldn't save`);
    } finally {
      setPending(false);
    }
  }

  async function giveSkill(skill: AgentSkillCatalogEntry, enabled: boolean) {
    setError(null);
    try {
      const updated = await rpc.agentSkills.setAccess({
        skillId: skill.id,
        bots: [{ botId: bot.id, enabled }],
      });
      setSkills((list) => list.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch {
      setError(t`Couldn't save`);
    }
  }

  const declared = new Set(sharing?.connectors.map(appKey));
  const giveApp = (app: App, checked: boolean) => {
    if (!sharing) return;
    const connectors = checked
      ? [...sharing.connectors, app.need]
      : sharing.connectors.filter((need) => appKey(need) !== app.key);
    void save({ visibility: sharing.visibility, userIds: sharing.userIds, connectors });
  };

  const everyone = sharing?.visibility === "space";
  const chosen = sharing?.visibility === "people" ? sharing.userIds : [];
  const toggle = (memberId: string, checked: boolean) => {
    const userIds = checked
      ? [...chosen, memberId]
      : chosen.filter((chosenId) => chosenId !== memberId);
    void save({ visibility: userIds.length > 0 ? "people" : "private", userIds });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="share-bot-dialog" className="gap-4">
        <DialogHeader>
          <DialogTitle className="break-words" dir="auto">
            <Trans>Share {bot.name}</Trans>
          </DialogTitle>
        </DialogHeader>
        {sharing ? (
          <div className="flex flex-col gap-4">
            <SettingsGroup>
              <SettingRow label={t`Everyone in ${spaceName}`}>
                <Switch
                  aria-label={t`Everyone in ${spaceName}`}
                  checked={everyone}
                  disabled={pending}
                  onCheckedChange={(checked) =>
                    void save(
                      checked
                        ? { visibility: "space", userIds: [] }
                        : { visibility: "private", userIds: [] },
                    )
                  }
                />
              </SettingRow>
            </SettingsGroup>
            {!everyone && people.length > 0 ? (
              <SettingsGroup>
                {people.map((member) => (
                  <SettingRow
                    key={member.userId}
                    leading={
                      <UserAvatar
                        initials={userInitials(member.name)}
                        image={member.image}
                        className="size-7 text-label"
                      />
                    }
                    label={member.name}
                  >
                    <Checkbox
                      aria-label={member.name}
                      checked={chosen.includes(member.userId)}
                      disabled={pending}
                      onCheckedChange={(checked) => toggle(member.userId, checked)}
                    />
                  </SettingRow>
                ))}
              </SettingsGroup>
            ) : null}
            {sharing.visibility !== "private" && skills.length > 0 ? (
              <SettingsGroup label={t`Skills this bot can use`}>
                {skills.map((skill) => (
                  <SettingRow key={skill.id} label={skill.name}>
                    <Checkbox
                      aria-label={skill.name}
                      checked={skill.visibleBotIds.includes(bot.id)}
                      onCheckedChange={(checked) => void giveSkill(skill, checked)}
                    />
                  </SettingRow>
                ))}
              </SettingsGroup>
            ) : null}
            {sharing.visibility !== "private" && apps.length > 0 ? (
              <SettingsGroup label={t`Apps this bot can use`}>
                {apps.map((app) => (
                  <SettingRow key={app.key} label={app.name}>
                    <Checkbox
                      aria-label={app.name}
                      checked={declared.has(app.key)}
                      disabled={pending}
                      onCheckedChange={(checked) => giveApp(app, checked)}
                    />
                  </SettingRow>
                ))}
              </SettingsGroup>
            ) : null}
            {sharing.visibility === "private" ? null : (
              <p className="text-meta text-muted-foreground">
                <Trans>Everyone who uses this bot can see its files and browser sign-ins.</Trans>
              </p>
            )}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-meta text-destructive">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
