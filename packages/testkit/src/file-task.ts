import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";

/** What the model was shown last: the content of the newest tool message. */
export const toolResult = (request: ModelEmulatorRequest) =>
  String(request.messages.findLast((message) => message.role === "tool")?.content);

const recap = JSON.stringify({ version: 1, results: ["Edited notes.md"], references: [] });

/**
 * The same file task for every arm, step by step: write, refuse an overwrite, edit, miss an edit,
 * read and list. What the model sees after each call is pushed to `seen`; `atEnd` runs at the last
 * model call, while the run is still live.
 */
export function fileTask(seen: string[], atEnd: () => void): ModelEmulatorStep[] {
  const calls: Array<[string, Record<string, unknown>]> = [
    ["write_file", { path: "notes.md", content: "alpha\nbeta\n" }],
    ["write_file", { path: "notes.md", content: "again" }],
    ["edit_file", { path: "notes.md", old_text: "beta", new_text: "gamma" }],
    ["edit_file", { path: "notes.md", old_text: "delta", new_text: "x" }],
    ["read_file", { path: "notes.md", offset: 2 }],
    ["list_files", {}],
    ["message_user", { message: "Done." }],
  ];
  return [
    ...calls.map(
      ([name, args], index): ModelEmulatorStep => ({
        expect(request) {
          if (index > 0) seen.push(toolResult(request));
        },
        response: { type: "tool", id: `call-${index}`, name, arguments: args },
      }),
    ),
    {
      expect(request) {
        seen.push(toolResult(request));
        atEnd();
      },
      response: { type: "text", text: recap },
    },
  ];
}
