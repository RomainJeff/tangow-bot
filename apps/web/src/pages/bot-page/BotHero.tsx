import { useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import {
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  SELECTABLE_BOT_COLORS,
} from "@rakazo/contracts";
import type { FieldSaveState } from "@rakazo/core";
import { SHAPES } from "@rakazo/core";
import {
  BotAvatar,
  type FieldSave,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SaveMeta,
  TextSettingField,
  useAvatarStyle,
} from "@rakazo/ui-web";
import { Pencil } from "lucide-react";
import { type BotPageContext, useBotField, useSaveLabels } from "./page-kit";

/** Read-only (an archived bot), the name and title still read as text, not as greyed fields. */
const HERO_INPUT =
  "h-auto border-transparent bg-transparent px-2 py-0.5 text-center dark:bg-transparent disabled:bg-transparent disabled:opacity-100 dark:disabled:bg-transparent";

/** The avatar, name and title at the top of the page, each saving on its own unless read-only. */
export function BotHero({ page }: { page: BotPageContext }) {
  const { t } = useLingui();
  const labels = useSaveLabels();
  const { bot, readOnly } = page;
  const name = useBotField(page, "name", bot.name, (value) => ({ name: value }));
  const title = useBotField(page, "title", bot.title, (value) => ({ title: value }));
  const color = useBotField(page, "color", bot.color, (value) => ({ color: value }));
  const shape = useBotField(page, "shapeSeed", bot.shapeSeed, (value) => ({ shapeSeed: value }));
  const meta = heroMeta([name, title, color, shape]);

  return (
    <section className="flex flex-col items-center gap-1 px-5 pt-2.5 text-center">
      <AppearancePicker
        bot={bot}
        color={color.value}
        shapeSeed={shape.value}
        disabled={readOnly}
        onColor={(value) => void color.save(value)}
        onShape={(value) => void shape.save(value)}
      />
      <TextSettingField
        label={<span className="sr-only">{t`Name`}</span>}
        field={name}
        labels={labels}
        meta={false}
        required
        maxLength={BOT_NAME_MAX_LENGTH}
        disabled={readOnly}
        dir="auto"
        className="mt-3 w-full gap-0"
        controlClassName={`${HERO_INPUT} text-title text-foreground md:text-title`}
      />
      <TextSettingField
        label={<span className="sr-only">{t`Title`}</span>}
        field={title}
        labels={labels}
        meta={false}
        maxLength={BOT_TITLE_MAX_LENGTH}
        disabled={readOnly}
        dir="auto"
        placeholder={t`What it does, in one line`}
        className="w-full gap-0"
        controlClassName={`${HERO_INPUT} text-meta text-muted-foreground md:text-meta`}
      />
      <SaveMeta
        state={meta?.state ?? IDLE}
        labels={labels}
        onRetry={() => void meta?.retry()}
        className="min-h-4"
      />
    </section>
  );
}

const IDLE: FieldSaveState<unknown> = { kind: "idle" };

/** The hero shares one meta line: a failure first, then a save in flight, then the latest save. */
type HeroField = Pick<FieldSave<unknown>, "state" | "retry">;

function heroMeta(fields: HeroField[]): HeroField | undefined {
  return (
    fields.find((field) => field.state.kind === "failed") ??
    fields.find((field) => field.state.kind === "saving") ??
    fields
      .filter((field) => field.state.kind === "saved")
      .sort((a, b) => savedAt(b.state) - savedAt(a.state))[0]
  );
}

function savedAt(state: FieldSaveState<unknown>): number {
  return state.kind === "saved" ? state.at : 0;
}

/** Avatar popover: the bot colour, and its organic shape when that avatar style is on. */
function AppearancePicker({
  bot,
  color,
  shapeSeed,
  disabled,
  onColor,
  onShape,
}: {
  bot: Bot;
  color: string;
  shapeSeed: number | null;
  disabled: boolean;
  onColor: (color: string) => void;
  onShape: (shapeSeed: number | null) => void;
}) {
  const { t } = useLingui();
  const avatarStyle = useAvatarStyle();
  return (
    <Popover>
      <PopoverTrigger
        data-testid="bot-appearance-trigger"
        aria-label={t`Appearance`}
        disabled={disabled}
        className="group relative rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <BotAvatar
          color={color}
          identity={bot.id}
          shapeSeed={shapeSeed}
          size={80}
          status={bot.status}
        />
        {disabled ? null : (
          <span
            aria-hidden
            className="absolute end-0 bottom-0 grid size-6 place-items-center rounded-full bg-surface text-muted-foreground opacity-0 shadow-row duration-(--duration-hover) ease-quiet group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            <Pencil className="size-3" strokeWidth={2} />
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent data-testid="bot-appearance-picker" aria-label={t`Appearance`}>
        {avatarStyle === "organic" ? (
          <div className="grid grid-cols-4 gap-1">
            {[null, ...SHAPES.map((_, index) => index)].map((seed) => (
              <button
                key={seed ?? "auto"}
                type="button"
                aria-pressed={shapeSeed === seed}
                aria-label={seed === null ? t`Automatic shape` : t`Shape ${seed + 1}`}
                onClick={() => onShape(seed)}
                className={`flex h-14.5 items-center justify-center rounded-row border duration-(--duration-hover) ease-quiet ${
                  shapeSeed === seed
                    ? "border-ring bg-muted"
                    : "border-transparent hover:border-ring/60"
                }`}
              >
                {seed === null ? (
                  <span className="text-time text-muted-foreground">{t`Auto`}</span>
                ) : (
                  <BotAvatar
                    color={color}
                    identity={bot.id}
                    shapeSeed={seed}
                    size={36}
                    variant="organic"
                  />
                )}
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap justify-center gap-3">
          {SELECTABLE_BOT_COLORS.map((swatch, index) => (
            <button
              key={swatch}
              type="button"
              aria-pressed={color === swatch}
              aria-label={t`Color ${index + 1}`}
              onClick={() => onColor(swatch)}
              style={{ background: swatch }}
              className={`size-7 rounded-full border border-outline ${
                color === swatch ? "ring-1 ring-ring ring-offset-2 ring-offset-popover" : ""
              }`}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
