import type { Peer, ThreadEntry } from "@rakazo/contracts";

export interface PeerMessage {
  messageId: string;
  direction: "sent" | "received";
  peerBotId: string;
  peerBotName: string;
  text: string;
  createdAt: string;
}

export interface PeerConversation {
  peerBotId: string;
  peerBotName: string;
  messages: PeerMessage[];
  lastText: string;
  lastAt: string;
}

/**
 * Strips a single leading `[to <name>] ` peer-address prefix for display in the peer-messages
 * exchange (spec `[to X]` bullet). This is a pure display cleanup, tolerant of surrounding
 * whitespace: the stored message and the history sent to the LLM (`packages/core/src/
 * attachments.ts`) keep the prefix untouched. Only the prefix anchored at the very start of the
 * string is removed; a `[to X]`-shaped substring anywhere else in the text is left alone.
 */
export function stripPeerAddressPrefix(text: string): string {
  return text.replace(/^\s*\[to [^\]]+?\]\s*/, "");
}

function peerId(peer: Peer): string {
  return peer.kind === "bot" ? peer.botId : peer.address;
}

function peerMessageOf(entry: ThreadEntry): PeerMessage | undefined {
  if (entry.type !== "bot.message.sent" && entry.type !== "bot.message.received") return undefined;
  const sent = entry.type === "bot.message.sent";
  const peer = sent ? entry.payload.to : entry.payload.from;
  return {
    messageId: entry.id,
    direction: sent ? "sent" : "received",
    peerBotId: peerId(peer),
    peerBotName: peer.name,
    text: entry.payload.text,
    createdAt: entry.ts,
  };
}

export function peerConversations(entries: readonly ThreadEntry[]): PeerConversation[] {
  const byPeer = new Map<string, PeerConversation>();
  for (const entry of entries) {
    const peerMessage = peerMessageOf(entry);
    if (!peerMessage) continue;
    const existing = byPeer.get(peerMessage.peerBotId);
    if (existing) {
      existing.messages.push(peerMessage);
      // Names can change; the newest one wins.
      existing.peerBotName = peerMessage.peerBotName;
      existing.lastText = peerMessage.text;
      existing.lastAt = peerMessage.createdAt;
      continue;
    }
    byPeer.set(peerMessage.peerBotId, {
      peerBotId: peerMessage.peerBotId,
      peerBotName: peerMessage.peerBotName,
      messages: [peerMessage],
      lastText: peerMessage.text,
      lastAt: peerMessage.createdAt,
    });
  }
  return [...byPeer.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}
