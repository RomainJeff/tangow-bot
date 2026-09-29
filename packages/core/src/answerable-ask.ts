type AskSnapshot = {
  messages: readonly {
    id: string;
    runId?: string | null;
    blocks: readonly { kind: string; status?: string; state?: string }[];
  }[];
  run?: { id: string; status: string } | null;
  activeRuns?: readonly { id: string; status: string }[];
};

export function latestAnswerableAskMessageId(snapshot: AskSnapshot | null): string | null {
  return latestWaitingMessageId(
    snapshot,
    "waiting_input",
    (block) => block.kind === "ask" && block.status !== "answered",
  );
}

/** The live "Needs you" card: the newest computer block of a run waiting for the user's screen. */
export function latestTakeoverMessageId(snapshot: AskSnapshot | null): string | null {
  return latestWaitingMessageId(
    snapshot,
    "waiting_takeover",
    (block) => block.kind === "computer" && block.state === "Needs you",
  );
}

function latestWaitingMessageId(
  snapshot: AskSnapshot | null,
  status: string,
  pending: (block: AskSnapshot["messages"][number]["blocks"][number]) => boolean,
): string | null {
  if (!snapshot) return null;
  const waitingRunIds = new Set(
    (snapshot.activeRuns ?? (snapshot.run ? [snapshot.run] : []))
      .filter((run) => run.status === status)
      .map((run) => run.id),
  );
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index];
    if (!message?.runId || !waitingRunIds.has(message.runId)) continue;
    if (message.blocks.some(pending)) return message.id;
  }
  return null;
}

export function selectedAskActionLabel(
  answer: string,
  actions?: readonly { id: string; label: string }[],
): string {
  return actions?.find((action) => action.id === answer)?.label ?? answer;
}
