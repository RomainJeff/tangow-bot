import type {
  AgentRunModel,
  AgentRunRequest,
  GuestBody,
  HarnessDeclaration,
  LocalToolOutput,
  ModelDialect,
  RefusalReason,
  ReplyFinal,
  ReplyPart,
  SubagentLog,
  WorkerIdentity,
  WorkerSkill,
} from "@rakazo/adapter-kit";
import { AgentRuntimeUnavailableError, FRAME_CAPABILITY } from "@rakazo/adapter-kit";
import { redactSecrets, secretRedactor } from "@rakazo/core";
import { redactPayloadValue, redactPayloadWith } from "../connector-safety.js";
import type { CapabilityKey } from "./capability.js";
import { mintCapability, verifyCapability } from "./capability.js";
import { relayPiAiCall } from "./dialects/pi-ai.js";
import { eventPipe } from "./event-pipe.js";
import type { FrameChannel } from "./framing.js";
import { encodeMessage, readGuestFrame } from "./framing.js";
import { base64Images, guestRunInput, nativeToolsForHarness } from "./guest-input.js";
import type { SessionInbox } from "./inbox.js";
import { createSessionInbox } from "./inbox.js";
import type { LaunchedGuest, WorkerLauncher } from "./launcher.js";
import { WORKER_LIMITS } from "./limits.js";
import type { ModelRelay, RelayUsage } from "./model-relay.js";
import { guestModelOf } from "./model-relay.js";
import type { StopJournal } from "./stop-journal.js";

/** The model-access dialects the controller relays. A new dialect is one entry here. */
const RELAYS: { [D in ModelDialect]: ModelRelay<never, unknown> } = {
  "pi-ai": relayPiAiCall as ModelRelay<never, unknown>,
};

export interface WorkerClock {
  sleep(ms: number): Promise<void>;
}

/** The guest broke the protocol: the run fails rather than retrying a hostile peer. */
export class WorkerViolationError extends Error {
  constructor(readonly reason: RefusalReason) {
    super(`The worker broke the run protocol: ${reason}`);
    this.name = "WorkerViolationError";
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function cutText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const marker = `\n\n[cut by the controller at ${maxBytes} bytes]`;
  return `${Buffer.from(text)
    .subarray(0, maxBytes - Buffer.byteLength(marker))
    .toString()}${marker}`;
}

type Helper = {
  log: SubagentLog;
  model: AgentRunModel;
  usage: { inputTokens: number; outputTokens: number };
};

/**
 * Masks secrets in a transcript's text. An image's base64 data is kept as it is: it would spend
 * the redaction budget and come back as a bare `[redacted]` in place of the image.
 */
function redactTranscript(value: unknown, redact: (text: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => redactTranscript(item, redact));
  if (value === null || typeof value !== "object") return redactPayloadWith(value, redact);
  const image = (value as { type?: unknown }).type === "image";
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      redact(key),
      image && key === "data" ? item : redactTranscript(item, redact),
    ]),
  );
}

/**
 * One attempt's guest, from launch to confirmed stop. Lives as long as the executor's run: a
 * controller restart ends the attempt, so everything here may stay in memory.
 */
export function createSession(
  request: AgentRunRequest,
  deps: { key: CapabilityKey; launcher: WorkerLauncher; stops: StopJournal; clock: WorkerClock },
) {
  if (!request.attempt) throw new Error("A worker run needs its attempt");
  const worker: WorkerIdentity = {
    runId: request.runId,
    attemptId: request.attempt.id,
    fence: request.attempt.fence,
  };
  const events = eventPipe();
  const tools = new Map(request.tools.map((tool) => [tool.name, tool]));
  const announced = new Map<string, string>();
  const open = new Map<string, Promise<unknown>>();
  const grants = new Map<string, ReturnType<typeof deferred<LocalToolOutput>>>();
  const helpers = new Map<string, Helper>();
  const relays = new Map<number, AbortController>();
  const reportedSkills: WorkerSkill[] = [];
  let reportedSkillBytes = 0;
  let skillIndexEnded = false;
  let skillUses = 0;
  let skillCollisions = 0;
  const mountedSkillSources = () =>
    new Set<WorkerSkill["source"]>([
      "managed",
      ...(launched?.start.workspace.mounts.map((mount) =>
        mount.scope === "private" ? ("bot" as const) : ("shared" as const),
      ) ?? []),
    ]);
  let modelRequests = 0;
  let harness: HarnessDeclaration | undefined;
  let launched: LaunchedGuest | undefined;
  let bound: FrameChannel | undefined;
  let stopping: Promise<void> | undefined;
  let finished = false;

  const clean = (text: string) => redactSecrets(text, [...(request.secrets ?? [])]);

  const fail = (error: Error) => {
    events.end(error);
  };

  const violation = (reason: RefusalReason, channel?: FrameChannel) => {
    channel?.close();
    bound?.close();
    fail(new WorkerViolationError(reason));
  };

  /** The attempt lost its run: nothing more is decided for this guest. */
  const revoke = (): ReplyFinal => {
    inbox.revoke();
    setImmediate(() => {
      bound?.close();
      fail(new AgentRuntimeUnavailableError("This attempt no longer holds the run"));
    });
    return { type: "refused", reason: "revoked" };
  };

  /** Refuses a request frame: the guest gets the refusal, then the channel ends. */
  const refuse = (reason: RefusalReason): ReplyFinal => {
    setImmediate(() => violation(reason));
    return { type: "refused", reason };
  };

  const declared = (body: GuestBody) => {
    const needed = FRAME_CAPABILITY[body.type];
    return !needed || Boolean(harness?.capabilities.includes(needed));
  };

  const allowed = (name: string) => tools.has(name);

  const helperOf = (agent: string) => (agent === "root" ? undefined : helpers.get(agent));

  async function callTool(body: Extract<GuestBody, { type: "tool.call" }>): Promise<ReplyFinal> {
    const { agent, callId, name, args } = body;
    if (!allowed(name) || announced.get(callId) !== name) return refuse("unknown_tool");
    if (Buffer.byteLength(JSON.stringify(args)) > WORKER_LIMITS.toolArgsBytes) {
      return refuse("too_large");
    }
    announced.delete(callId);
    const helper = helperOf(agent);
    if (agent !== "root" && !helper) return refuse("invalid");
    if (harness && nativeToolsForHarness(harness.name).some((tool) => tool.name === name)) {
      const executeLocal = helper ? helper.log.executeLocalTool : request.executeLocalTool;
      if (!executeLocal) return { type: "error", message: `${name} is unavailable here` };
      const granted = deferred<void>();
      const call = executeLocal(name, args, callId, () => {
        const output = deferred<LocalToolOutput>();
        grants.set(callId, output);
        granted.resolve();
        return output.promise;
      });
      open.set(callId, call);
      void call.then(
        () => open.delete(callId),
        () => open.delete(callId),
      );
      const first = await Promise.race([
        granted.promise.then(() => ({ granted: true as const })),
        call.then(
          (output) => ({ granted: false as const, output }),
          (error: unknown) => ({ granted: false as const, error }),
        ),
      ]);
      if (first.granted) return { type: "tool.grant" };
      if ("error" in first) return { type: "error", message: clean(messageOf(first.error)) };
      return { type: "tool.result", output: first.output };
    }
    const execute = helper ? helper.log.executeTool : request.executeTool;
    if (!execute) return { type: "error", message: `${name} is unavailable here` };
    const call = execute(name, args, callId, tools.get(name)?.route);
    open.set(callId, call);
    try {
      return { type: "tool.result", output: await call };
    } catch (error) {
      return { type: "error", message: clean(messageOf(error)) };
    } finally {
      open.delete(callId);
    }
  }

  async function recordLocalResult(
    body: Extract<GuestBody, { type: "tool.done" }>,
  ): Promise<ReplyFinal> {
    const grant = grants.get(body.callId);
    if (!grant) return refuse("invalid");
    grants.delete(body.callId);
    const { output } = body;
    grant.resolve(
      "result" in output
        ? {
            result: redactPayloadValue(output.result, [
              ...(request.secrets ?? []),
            ]) as typeof output.result,
          }
        : {
            ...output,
            text: cutText(clean(output.text), WORKER_LIMITS.controllerResultBytes),
            ...(output.spoolPath ? { spoolPath: clean(output.spoolPath) } : {}),
          },
    );
    try {
      await open.get(body.callId);
      return { type: "tool.recorded" };
    } catch (error) {
      // The result is not durable: the effect stays started and the attempt ends here.
      fail(error instanceof Error ? error : new Error(String(error)));
      return { type: "error", message: "The result could not be recorded" };
    }
  }

  async function relayModel(
    seq: number,
    body: Extract<GuestBody, { type: "model.request" }>,
    part: (body: ReplyPart) => void,
  ): Promise<ReplyFinal> {
    modelRequests += 1;
    if (modelRequests > WORKER_LIMITS.modelRequestsPerAttempt) return refuse("budget");
    const helper = helperOf(body.agent);
    if (body.agent !== "root" && !helper) return refuse("invalid");
    const abort = new AbortController();
    relays.set(seq, abort);
    try {
      // The guest's own tool output reaches its transcript unredacted: mask it before the provider.
      const call = redactTranscript(body.call, secretRedactor([...(request.secrets ?? [])]));
      const usage: RelayUsage | undefined = await RELAYS[body.dialect](
        helper?.model ?? request.model,
        call as never,
        (event) => part({ type: "model.event", event } as ReplyPart),
        {
          signal: abort.signal,
          conversation: {
            threadId: request.threadId,
            botId: request.botId,
            ...(helper ? { helper: body.agent } : {}),
          },
        },
      );
      if (usage) {
        if (helper) {
          helper.usage.inputTokens += usage.inputTokens;
          helper.usage.outputTokens += usage.outputTokens;
        }
        await events.push(usage);
      }
      return { type: "model.end" };
    } finally {
      relays.delete(seq);
    }
  }

  async function finish(
    body: Extract<GuestBody, { type: "done" }>,
    part: (body: ReplyPart) => void,
  ) {
    // The harness's end does not close a run still waiting on a tool: hold it until all settle.
    if (open.size > 0) {
      part({ type: "end.refused", pending: [...open.keys()] });
      while (open.size > 0) await Promise.allSettled([...open.values()]);
    }
    finished = true;
    const done = events.push({
      type: "done",
      ...(body.text === undefined ? {} : { text: clean(body.text) }),
      ...(body.privateFinalText === undefined
        ? {}
        : { privateFinalText: clean(body.privateFinalText) }),
      ...(body.runtimeNotice === undefined ? {} : { runtimeNotice: clean(body.runtimeNotice) }),
    });
    events.end();
    await done;
    return { type: "stop", reason: "done" } as const;
  }

  async function handle(
    seq: number,
    body: GuestBody,
    part: (body: ReplyPart) => void,
  ): Promise<ReplyFinal> {
    if (!declared(body)) return refuse("undeclared");
    switch (body.type) {
      case "text":
        await events.push({ type: "text", text: clean(body.text) });
        return { type: "ack" };
      case "progress":
        await events.push({
          type: "progress",
          text: clean(body.text),
          ...(body.activity ? { activity: true } : {}),
        });
        return { type: "ack" };
      case "tool":
        if (!allowed(body.name)) return refuse("unknown_tool");
        if (Buffer.byteLength(JSON.stringify(body.args)) > WORKER_LIMITS.toolArgsBytes) {
          return refuse("too_large");
        }
        announced.set(body.executionId, body.name);
        await events.push({
          type: "tool",
          name: body.name,
          args: body.args,
          executionId: body.executionId,
        });
        return { type: "ack" };
      case "subagent":
        await events.push({
          ...body,
          task: clean(body.task),
          ...(body.progress === undefined ? {} : { progress: clean(body.progress) }),
          ...(body.result === undefined ? {} : { result: clean(body.result) }),
        });
        return { type: "ack" };
      case "model.request":
        return relayModel(seq, body, part);
      case "model.latency":
        // Guest diagnostics never authorize work or affect the run's outcome.
        return { type: "ack" };
      case "model.abort":
        relays.get(body.re)?.abort();
        return { type: "ack" };
      case "tool.call":
        // The executor checks its lease only between events: a guest must not outrun it.
        if (!(await launched!.holdsFence())) return revoke();
        return callTool(body);
      case "tool.done":
        return recordLocalResult(body);
      case "steering.claim": {
        const messages = (await request.claimSteering?.(body.seenIds)) ?? [];
        return {
          type: "steering",
          messages: messages.map((message) => ({
            id: message.id,
            messageId: message.messageId,
            text: message.text,
            ...(message.historyText === undefined ? {} : { historyText: message.historyText }),
            images: base64Images(message.images),
          })),
        };
      }
      case "subagent.open": {
        if (!request.startSubagent || !request.resolveModel) {
          return { type: "error", message: "Helpers are unavailable in this run" };
        }
        const model = await request.resolveModel(body.model.provider, body.model.id);
        const log = await request.startSubagent({
          callId: body.callId,
          name: body.name,
          task: body.task,
          args: body.args,
          model: body.model,
        });
        const agent = `helper:${helpers.size + 1}`;
        helpers.set(agent, { log, model, usage: { inputTokens: 0, outputTokens: 0 } });
        return { type: "subagent.opened", agent, model: guestModelOf(model) };
      }
      case "subagent.text":
      case "subagent.finish":
      case "subagent.abandon": {
        const helper = helperOf(body.agent);
        if (!helper) return refuse("invalid");
        if (body.type === "subagent.text") await helper.log.text(body.text);
        else if (body.type === "subagent.abandon") await helper.log.abandon(body.result);
        else {
          await helper.log.finish({
            status: body.status,
            result: body.result,
            usage: helper.usage,
          });
        }
        return { type: "recorded" };
      }
      case "ask":
        await events.push({
          ...body,
          text: clean(body.text),
          ...(body.detail === undefined ? {} : { detail: clean(body.detail) }),
        });
        return { type: "recorded" };
      case "takeover":
        await events.push({ type: "takeover", reason: clean(body.reason) });
        return { type: "recorded" };
      case "done":
        return finish(body, part);
      case "skills.index": {
        if (!(await launched!.holdsFence())) return revoke();
        if (skillIndexEnded || !mountedSkillSources().has(body.skill.source))
          return refuse("invalid");
        const bytes = Buffer.byteLength(JSON.stringify(body.skill));
        if (
          reportedSkills.length >= 512 ||
          reportedSkillBytes + bytes > WORKER_LIMITS.modelRequestBytes
        )
          return refuse("budget");
        reportedSkills.push(body.skill);
        reportedSkillBytes += bytes;
        return { type: "recorded" };
      }
      case "skills.index.end":
        if (!(await launched!.holdsFence())) return revoke();
        if (
          skillIndexEnded ||
          body.sources.some((source) => !mountedSkillSources().has(source)) ||
          reportedSkills.some((skill) => !body.sources.includes(skill.source))
        )
          return refuse("invalid");
        skillIndexEnded = true;
        await request.onSkillIndex?.(reportedSkills, body.sources);
        reportedSkills.length = 0;
        reportedSkillBytes = 0;
        return { type: "recorded" };
      case "skills.collision":
        if (!(await launched!.holdsFence())) return revoke();
        if (++skillCollisions > 512) return refuse("budget");
        if (
          ![body.collision.kept, body.collision.ignored].every((source) =>
            mountedSkillSources().has(source),
          )
        )
          return refuse("invalid");
        await request.onSkillCollision?.({ ...body.collision, name: clean(body.collision.name) });
        return { type: "recorded" };
      case "skills.used":
        if (!(await launched!.holdsFence())) return revoke();
        if (++skillUses > 512) return refuse("budget");
        await request.onSkillUsed?.(clean(body.name));
        return { type: "recorded" };
      case "failed":
        fail(new Error(clean(body.message)));
        return { type: "stop", reason: "cancelled" };
    }
  }

  const inbox: SessionInbox = createSessionInbox(worker, handle);

  /** One connection: a hello first, checked before anything else is read or written. */
  async function serve(channel: FrameChannel) {
    let accepted = false;
    try {
      for await (const frame of channel.frames) {
        const read = readGuestFrame(frame);
        if (!read.ok) return violation(read.reason, channel);
        const message = read.message;
        if (!accepted) {
          if (message.kind !== "worker.hello") return violation("invalid", channel);
          const verdict = verifyCapability(deps.key, message.capability, worker, Date.now());
          if (!verdict.ok) {
            return violation(verdict.reason === "identity" ? "identity" : "capability", channel);
          }
          // Single use: one bound connection at a time, and none once the stop began.
          if (bound || stopping) return channel.close();
          accepted = true;
          bound = channel;
          harness ??= message.harness;
          await channel.send(
            encodeMessage({
              ...launched!.start,
              run: guestRunInput(request, harness),
            }),
          );
          inbox.attach((reply) => void channel.send(encodeMessage(reply)));
          continue;
        }
        if (message.kind !== "worker.event") return violation("invalid", channel);
        const outcome = inbox.accept(message);
        if (!outcome.ok) return violation(outcome.reason, channel);
      }
    } catch {
      // A frame over the length limit, or a broken stream.
      if (!stopping) violation("too_large", channel);
    } finally {
      if (bound === channel) {
        inbox.detach();
        bound = undefined;
      }
    }
  }

  async function connect(guest: LaunchedGuest) {
    const serving: Promise<void>[] = [];
    void deps.clock.sleep(WORKER_LIMITS.helloDeadlineMs).then(() => {
      if (!harness) fail(new AgentRuntimeUnavailableError("The worker did not say hello in time"));
    });
    for await (const channel of guest.connections) serving.push(serve(channel));
    await Promise.all(serving);
    if (!finished && !stopping) {
      fail(new AgentRuntimeUnavailableError("The worker disconnected before the run ended"));
    }
  }

  async function stop(signal: AbortSignal | undefined) {
    inbox.revoke();
    for (const relay of relays.values()) relay.abort();
    events.drain();
    // The executor stops writing results only once it saw its signal abort.
    const rejectGrants = () => {
      for (const grant of grants.values()) grant.reject(new Error("The worker stopped"));
      grants.clear();
    };
    if (!signal || signal.aborted) rejectGrants();
    else signal.addEventListener("abort", rejectGrants, { once: true });
    if (!launched) return;
    const guest = launched;
    await deps.stops.mark(worker.attemptId, "requested");
    const ended = guest.exited.then(() => deps.stops.mark(worker.attemptId, "process_ended"));
    // An unconfirmed stop never awaits `ended`, so its late failure must not crash the process.
    ended.catch(() => undefined);
    if (bound) {
      await bound.send(encodeMessage({ version: 1, kind: "worker.cancel", worker }));
    }
    await Promise.race([guest.exited, deps.clock.sleep(WORKER_LIMITS.cancelGraceMs)]);
    const released = guest.release().then(
      (outcome) => outcome === "released",
      () => false,
    );
    const confirmed = await Promise.race([
      released,
      deps.clock.sleep(WORKER_LIMITS.stopConfirmMs - WORKER_LIMITS.cancelGraceMs).then(() => false),
    ]);
    if (confirmed) await ended;
    else await deps.stops.mark(worker.attemptId, "unconfirmed");
    bound?.close();
  }

  return {
    worker,
    events,
    async open() {
      const capability = mintCapability(deps.key, worker, Date.now());
      launched = await deps.launcher.launch(worker, capability);
      void connect(launched).catch((error: unknown) =>
        fail(error instanceof Error ? error : new Error(String(error))),
      );
    },
    /** Idempotent. Resolves once the VM is confirmed gone or recorded as unconfirmed. */
    stop(signal: AbortSignal | undefined) {
      stopping ??= stop(signal);
      return stopping;
    },
    cancel(error: Error) {
      events.end(error);
    },
  };
}
