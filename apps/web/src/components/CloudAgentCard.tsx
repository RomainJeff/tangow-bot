import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { cloudAgentHttpsUrl } from "@rakazo/core";
import { TaskCardSurface } from "./TaskCard";

/**
 * Same outlined container, glyph and status rule as `TaskCard` (spec 9b): no
 * status word once `finished`, the meta line says "Pull request" or the
 * branch, and there is never a result. The whole card always opens its pull
 * request (or its URL) in a new tab, so it keeps its own link wrapper instead
 * of `TaskCard`'s dialog-opening button.
 */
export function CloudAgentCard({
  block,
}: {
  block: Extract<MessageBlock, { kind: "cloud_agent" }>;
}) {
  const { t } = useLingui();
  const prHref = cloudAgentHttpsUrl(block.prUrl);
  const href = prHref ?? cloudAgentHttpsUrl(block.url);
  const state =
    block.status === "running"
      ? "running"
      : block.status === "finished"
        ? "done"
        : block.status === "cancelled"
          ? "cancelled"
          : "failed";
  const content = (
    <div data-testid="cloud-agent-card" className="w-80 max-w-full">
      <TaskCardSurface
        title={block.title}
        state={state}
        meta={prHref ? t`Pull request` : block.branch}
      />
    </div>
  );
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="block max-w-full no-underline">
      {content}
    </a>
  ) : (
    content
  );
}
