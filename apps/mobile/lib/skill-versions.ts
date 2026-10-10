import { serverMessage } from "./server-error";

export type UndoOutcome =
  | { kind: "restored"; skillId: string }
  | { kind: "trashed" }
  | { kind: "refused"; message: string };

type UndoResult = { kind: "restored"; skillId: string; name: string } | { kind: "trashed" };

/** What the screen does after an Undo: show the new state, leave, or say why it was refused. */
export async function undoOutcome(undo: () => Promise<UndoResult>): Promise<UndoOutcome> {
  try {
    const result = await undo();
    return result.kind === "trashed" ? result : { kind: "restored", skillId: result.skillId };
  } catch (error) {
    return { kind: "refused", message: serverMessage(error) };
  }
}
