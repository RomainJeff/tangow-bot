import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  ProcessEvent,
} from "@tangow/adapter-kit";
import { VolumeComputer } from "../volume-computer.js";

/**
 * The eval's computer, whose files are the trial's worker volumes. A model must not receive
 * successful shell results for commands the fixture never ran.
 */
export class EvalSandboxProvider extends VolumeComputer {
  readonly harnessIssues: string[] = [];

  override async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    if (request.argv[3] === "tangow-background-launch") {
      const issue = "Shell execution is unavailable in this offline eval sandbox.";
      if (!this.harnessIssues.includes(issue)) this.harnessIssues.push(issue);
      yield { type: "stderr", data: issue };
      yield { type: "exit", code: 127 };
      return;
    }
    yield* super.execute(computer, request, context);
  }
}
