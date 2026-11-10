import type { SearchHit } from "@rakazo/contracts";

/** `sharedBot`: the hit's bot was shared with you, and its routine screens are its owner's. */
export function mobileSearchDestination(
  hit: SearchHit,
  sharedBot = false,
):
  | {
      pathname: "/bot-routine";
      params: { botId: string; routineId: string };
    }
  | {
      pathname: "/group-thread";
      params: { groupId: string; name: string; messageId?: string };
    }
  | {
      pathname: "/thread";
      params: { botId: string; name: string; messageId?: string };
    } {
  if (hit.routineId && !sharedBot) {
    return { pathname: "/bot-routine", params: { botId: hit.botId!, routineId: hit.routineId } };
  }
  if (hit.groupId) {
    return {
      pathname: "/group-thread",
      params: {
        groupId: hit.groupId,
        name: hit.groupName ?? hit.title,
        ...(hit.messageId ? { messageId: hit.messageId } : {}),
      },
    };
  }
  return {
    pathname: "/thread",
    params: {
      botId: hit.botId!,
      name: hit.botName ?? hit.title,
      ...(hit.messageId ? { messageId: hit.messageId } : {}),
    },
  };
}
