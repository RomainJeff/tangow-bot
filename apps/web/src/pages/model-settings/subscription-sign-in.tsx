import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input } from "@tangow/ui-web";
import type { ModelSettings } from "./use-model-settings";

export function SubscriptionSignIn({
  oauth,
  pasteCode,
  setPasteCode,
  submitOAuthCode,
  busy,
  oauthPending,
  oauthLabel,
  beginSelectedSubscriptionSignIn,
}: Pick<
  ModelSettings,
  | "oauth"
  | "pasteCode"
  | "setPasteCode"
  | "submitOAuthCode"
  | "busy"
  | "oauthPending"
  | "beginSelectedSubscriptionSignIn"
> & { oauthLabel: string | undefined }) {
  const { t } = useLingui();
  return (
    <div className="mt-5">
      {oauth ? (
        <div className="rounded-card bg-group shadow-group px-4 py-3">
          {oauth.mode === "auth-url" ? (
            <>
              <p className="text-sm leading-[1.5] text-muted-foreground">
                <Trans>
                  Finish signing in at{" "}
                  <a
                    href={oauth.verificationUri}
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground underline"
                  >
                    {new URL(oauth.verificationUri).hostname}
                  </a>
                  . The final page may not load; paste its URL or code here.
                </Trans>
              </p>
              <div className="mt-3 flex items-center gap-2">
                <Input
                  value={pasteCode}
                  onChange={(e) => setPasteCode(e.target.value)}
                  aria-label={t`Authorization code or callback URL`}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="http://localhost:53692/callback?code=…"
                  className="text-foreground md:text-[13px]"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!pasteCode.trim()}
                  onClick={() => void submitOAuthCode()}
                >
                  <Trans>Submit</Trans>
                </Button>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                <Trans>Waiting for sign-in…</Trans>
              </p>
            </>
          ) : (
            <>
              <p className="text-sm leading-[1.5] text-muted-foreground">
                <Trans>
                  Enter this code at{" "}
                  <a
                    href={oauth.verificationUri}
                    target="_blank"
                    rel="noreferrer"
                    className="text-foreground underline"
                  >
                    {oauth.verificationUri.replace(/^https:\/\//, "")}
                  </a>
                </Trans>
              </p>
              <p className="mt-2 font-mono text-[22px] tracking-[0.2em] text-foreground">
                {oauth.userCode}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                <Trans>Waiting for sign-in…</Trans>
              </p>
            </>
          )}
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => beginSelectedSubscriptionSignIn()}
        >
          {oauthPending ? <Trans>Starting…</Trans> : (oauthLabel ?? t`Sign in`)}
        </Button>
      )}
    </div>
  );
}
