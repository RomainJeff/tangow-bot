export type GroupMemberRef = {
  id: string;
  name: string;
};

const MENTION_PATTERN = /@([A-Za-z0-9][A-Za-z0-9_-]{0,39})/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasMentionToken(text: string, name: string): boolean {
  const normalized = name.trim();
  if (!normalized) return false;
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}_-])@${escapeRegExp(normalized)}(?![\\p{L}\\p{N}_-])`,
    "iu",
  ).test(text);
}

export function parseMentionNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const name = match[1];
    if (name) names.add(name.toLowerCase());
  }
  return [...names];
}

/** The bot that answers a group message naming none: its lead while a member, else the first. */
export function groupLeadBotId(
  members: ReadonlyArray<{ id: string }>,
  leadBotId: string | null | undefined,
): string | undefined {
  return (members.find((member) => member.id === leadBotId) ?? members[0])?.id;
}

/**
 * The bots a person's group message wakes: those it names, every one for @everyone, or the lead
 * when it names none. A bot the sender cannot use wakes for nothing: its name stays plain text.
 */
export function resolveGroupTargetBotIds(input: {
  text: string;
  members: GroupMemberRef[];
  /** Bot ids from typed mention chips (non-members are ignored for wake). */
  explicitMentions?: string[];
  leadBotId?: string | null;
  /** The members the sender owns or has been shared. */
  usableBotIds: ReadonlySet<string>;
}): string[] {
  const usable = input.members.filter((member) => input.usableBotIds.has(member.id));
  const targetIds = new Set<string>();

  for (const mentionId of input.explicitMentions ?? []) {
    // Out-of-chat bots stay as @Name in the prompt; only members are woken here.
    if (usable.some((member) => member.id === mentionId)) targetIds.add(mentionId);
  }

  if (hasMentionToken(input.text, "everyone")) {
    for (const member of usable) targetIds.add(member.id);
  } else {
    for (const member of usable) {
      if (hasMentionToken(input.text, member.name)) targetIds.add(member.id);
    }
  }

  const lead = groupLeadBotId(input.members, input.leadBotId);
  if (targetIds.size === 0 && lead && input.usableBotIds.has(lead)) targetIds.add(lead);

  return [...targetIds];
}

export function inferHandoffTargetName(prompt: string): string | undefined {
  const handoffMatch =
    /hand(?:\s+this|\s+off|\s+it)?\s+to\s+@?([A-Za-z0-9][A-Za-z0-9_-]{0,39})/i.exec(prompt) ??
    /@([A-Za-z0-9][A-Za-z0-9_-]{0,39})\s+take/i.exec(prompt);
  return handoffMatch?.[1];
}

export function inferHandoffTargetBotId(
  prompt: string,
  members: GroupMemberRef[],
): string | undefined {
  const handedTo = members.find((member) => {
    const escaped = escapeRegExp(member.name.trim());
    return escaped
      ? new RegExp(`\\bto\\s+@?${escaped}(?![\\p{L}\\p{N}_-])`, "iu").test(prompt)
      : false;
  });
  if (handedTo) return handedTo.id;
  const mentioned = members.find((member) => hasMentionToken(prompt, member.name));
  if (mentioned) return mentioned.id;
  const name = inferHandoffTargetName(prompt)?.toLowerCase();
  return name ? members.find((member) => member.name.toLowerCase() === name)?.id : undefined;
}
