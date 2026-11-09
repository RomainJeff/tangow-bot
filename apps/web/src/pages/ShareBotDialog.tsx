import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, BotSharing, SpaceMembers } from "@rakazo/contracts";
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

/**
 * Who besides its owner uses the bot: everyone in the Space, or the people ticked. Each change
 * saves itself; no one ticked means only the owner.
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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([
      rpc.bots.sharing({ botId: bot.id }),
      rpc.spaces.members({ spaceId: bot.spaceId }),
    ]).then(
      ([current, view]) => {
        if (!live) return;
        setSharing(current);
        setPeople(view.members.filter((member) => member.userId !== userId));
      },
      () => live && setError(t`Couldn't load`),
    );
    return () => {
      live = false;
    };
  }, [bot.id, bot.spaceId, userId, t]);

  async function save(next: BotSharing) {
    const previous = sharing;
    setSharing(next);
    setPending(true);
    setError(null);
    try {
      setSharing(await rpc.bots.share({ botId: bot.id, ...next }));
    } catch (failure) {
      setSharing(previous);
      // A refusal the API explains, such as a bot still running, says why.
      setError(saveFailureReason(failure) || t`Couldn't save`);
    } finally {
      setPending(false);
    }
  }

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
