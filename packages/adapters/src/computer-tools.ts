import { randomUUID } from "node:crypto";
import type {
  AgentToolExecutionResult,
  ComputerAction,
  ComputerObservation,
} from "@tangow/adapter-kit";

export function parseComputerActions(value: unknown): ComputerAction[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("computer_act requires at least one action");
  }
  if (value.length > 24) throw new Error("computer_act accepts at most 24 actions");
  const actions = value.flatMap((raw): ComputerAction[] => {
    if (!raw || typeof raw !== "object") throw new Error("computer action must be an object");
    const action = raw as Record<string, unknown>;
    const kind = String(action.kind ?? "");
    if (kind === "click" || kind === "move" || kind === "down" || kind === "up") {
      const x = finiteCoordinate(action.x, "x");
      const y = finiteCoordinate(action.y, "y");
      const pointer: ComputerAction = {
        kind: "pointer",
        x,
        y,
        type: kind,
        button: action.button === "right" ? "right" : "left",
      };
      return action.double === true && kind === "click" ? [pointer, pointer] : [pointer];
    }
    if (kind === "type") {
      return [{ kind: "clipboard", text: String(action.text ?? "") }];
    }
    if (kind === "key") {
      return [
        {
          kind: "key",
          key: String(action.key ?? ""),
          modifiers: Array.isArray(action.modifiers) ? action.modifiers.map(String) : undefined,
        },
      ];
    }
    if (kind === "scroll") {
      return [
        {
          kind: "scroll",
          direction: action.direction === "up" ? "up" : "down",
          amount: boundedNumber(action.amount, 1, 20, 3),
        },
      ];
    }
    if (kind === "wait") {
      return [{ kind: "wait", ms: boundedNumber(action.ms, 0, 5_000, 350) }];
    }
    throw new Error(`unsupported computer action ${kind || "(missing)"}`);
  });
  if (actions.length > 24) {
    throw new Error("computer_act expands to more than 24 actions; split the batch");
  }
  return actions;
}

/**
 * Where a screen is saved: a new file at the root of the bot's home, the volume's mount point,
 * under a name nobody can guess. The guest writes to that volume too, so a directory there could be
 * a link to another bot's files; the root and a name that does not exist yet cannot.
 */
export function screenPath(): string {
  return `.rakazo-screen-${randomUUID()}.png`;
}

/** `savedAt`: the screen is a file there, so the result names it instead of carrying the image. */
export function observationToolResult(
  observation: ComputerObservation,
  note = "computer observed",
  previousFrameId?: string,
  savedAt?: string,
): AgentToolExecutionResult {
  const details = {
    frameId: observation.frameId,
    capturedAt: observation.capturedAt,
    width: observation.width,
    height: observation.height,
    cursor: observation.cursor,
    activeWindow: observation.activeWindow,
    ...(savedAt ? { path: savedAt } : {}),
  };
  const unchanged = previousFrameId === observation.frameId;
  return {
    kind: "agent_tool_result",
    content: [
      {
        type: "text",
        text: `${note}${unchanged ? " (screen unchanged)" : ""}\n${JSON.stringify(details)}${savedAt && !unchanged ? `\nScreen saved at ${savedAt}. Read it to see it.` : ""}`,
      },
      ...(unchanged || savedAt
        ? []
        : [
            {
              type: "image" as const,
              data: Buffer.from(observation.image).toString("base64"),
              mimeType: observation.mimeType,
            },
          ]),
    ],
    details,
  };
}

function finiteCoordinate(value: unknown, name: string) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number < 0 || number > 100_000) {
    throw new Error(`computer action ${name} must be a non-negative coordinate`);
  }
  return number;
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.round(number), min), max);
}
