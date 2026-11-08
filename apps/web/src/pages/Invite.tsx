import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { LoadingState } from "../components/ai/primitives";
import { dropInvite } from "../lib/pending-invite";
import { rpc, selectSpace } from "../lib/rpc";

type InviteState =
  | { kind: "loading" }
  | { kind: "ready"; spaceName: string; inviterName: string; joining: boolean }
  | { kind: "unavailable" };

export function InvitePage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<InviteState>({ kind: "loading" });

  useEffect(() => {
    dropInvite();
    let cancelled = false;
    void rpc.spaces
      .invitation({ token })
      .catch(() => null)
      .then((invitation) => {
        if (cancelled) return;
        setState(
          invitation ? { kind: "ready", ...invitation, joining: false } : { kind: "unavailable" },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function join() {
    if (state.kind !== "ready") return;
    setState({ ...state, joining: true });
    try {
      const { spaceId } = await rpc.spaces.acceptInvite({ token });
      selectSpace(spaceId);
      navigate("/app", { replace: true });
    } catch {
      setState({ kind: "unavailable" });
    }
  }

  return (
    <div
      className="rk-ambient flex min-h-full items-center justify-center px-6 py-16 text-center text-foreground"
      data-testid="invite-page"
    >
      {state.kind === "loading" ? <LoadingState /> : null}
      {state.kind === "ready" ? (
        <div className="flex w-full max-w-[460px] flex-col items-center">
          <h1 className="text-4xl font-medium tracking-tight">
            <Trans>Join {state.spaceName}</Trans>
          </h1>
          <p className="mt-3 text-muted-foreground">
            <Trans>Invited by {state.inviterName}</Trans>
          </p>
          <Button
            size="lg"
            className="mt-9 h-12 w-full rounded-full text-base"
            disabled={state.joining}
            onClick={() => void join()}
          >
            <Trans>Join</Trans>
          </Button>
        </div>
      ) : null}
      {state.kind === "unavailable" ? (
        <div className="flex flex-col items-center">
          <p className="text-muted-foreground">
            <Trans>This invite link has expired or was already used.</Trans>
          </p>
          <Button
            variant="secondary"
            className="mt-4 rounded-full"
            onClick={() => navigate("/app", { replace: true })}
          >
            <Trans>Continue</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
