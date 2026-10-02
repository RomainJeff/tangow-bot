import { useLingui } from "@lingui/react/macro";
import type { TaskTreeNode, ThreadMessage } from "@rakazo/contracts";
import { Button, Dialog, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { useDisplayAgentSteps } from "../../lib/agent-steps-pref";
import { hasRenderableBlock } from "../../lib/message-blocks";
import { rpc } from "../../lib/rpc";
import { FALLBACK_BOT_COLOR } from "../../pages/shell/layout";
import { LoadEarlierButton, MessageFrame, messageChrome } from "../../pages/shell/message-frame";
import { MessageView } from "../../pages/shell/message-view";

type Page = { messages: ThreadMessage[]; olderCursor: number | null };

const noop = async () => undefined;

/**
 * A specialist's own thread for its owner to read, never to write to: it is drawn by the
 * transcript's message renderer, read-only, and `works.thread` offers no write. It belongs to no
 * task tree, so it is rendered outside the one that opened it.
 */
export function WorkThreadDialog({
  node,
  onClose,
}: {
  node: TaskTreeNode | null;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const showSteps = useDisplayAgentSteps();
  const workId = node?.workId;
  const [page, setPage] = useState<Page | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!workId) return;
    let stale = false;
    setPage(null);
    setFailed(false);
    rpc.works
      .thread({ workId })
      .then((loaded) => {
        if (!stale) setPage({ messages: loaded.messages, olderCursor: loaded.olderCursor });
      })
      .catch(() => {
        if (!stale) setFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [workId, reload]);

  async function loadOlder() {
    if (!workId || page?.olderCursor == null) return;
    setLoadingOlder(true);
    try {
      const older = await rpc.works.thread({ workId, before: page.olderCursor });
      setPage((current) =>
        current
          ? {
              messages: [...older.messages, ...current.messages],
              olderCursor: older.olderCursor,
            }
          : current,
      );
    } catch {
      setFailed(true);
    } finally {
      setLoadingOlder(false);
    }
  }

  const name = node?.executor.name || t`Specialist`;
  const specialist = node?.executor;
  const messages = (page?.messages ?? []).filter((message) =>
    hasRenderableBlock(message.blocks, showSteps),
  );
  return (
    <Dialog open={node !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent
        data-testid="work-thread-dialog"
        className="flex h-full max-h-[calc(100%-2rem)] flex-col gap-0 p-0 sm:max-w-thread"
      >
        <div className="px-4 pt-4 pb-3">
          <DialogTitle className="truncate" dir="auto">
            {name}
          </DialogTitle>
        </div>
        <div className="rk-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-6">
          {failed ? (
            <div className="flex flex-col items-center gap-3 py-8 text-meta text-muted-foreground">
              {t`Could not load this chat.`}
              <Button variant="tertiary" size="capsule" onClick={() => setReload(reload + 1)}>
                {t`Retry now`}
              </Button>
            </div>
          ) : page === null ? (
            <p className="py-8 text-center text-meta text-muted-foreground">{t`Loading…`}</p>
          ) : (
            <>
              {page.olderCursor != null ? (
                <LoadEarlierButton loading={loadingOlder} onClick={() => void loadOlder()} />
              ) : null}
              {specialist
                ? messages.map((message) => {
                    const chrome = messageChrome(message, showSteps);
                    return (
                      <MessageFrame key={message.id} message={message} chrome={chrome}>
                        <MessageView
                          artifactTarget={{ botId: specialist.botId }}
                          chrome={chrome}
                          message={message}
                          canAnswer={false}
                          readOnly
                          onAnswer={noop}
                          onOpenBot={() => undefined}
                          onOpenPeerMessages={() => undefined}
                          peerBot={(botId) => ({
                            color: FALLBACK_BOT_COLOR,
                            name: botId === specialist.botId ? name : undefined,
                          })}
                          onRefresh={noop}
                          onBotChanged={noop}
                          onAddRoutine={() => undefined}
                        />
                      </MessageFrame>
                    );
                  })
                : null}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
