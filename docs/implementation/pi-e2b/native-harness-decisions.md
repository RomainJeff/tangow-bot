# Native harness decisions

Decided on 2026-10-21 after the spike that runs Pi with its own loop in the worker VM. These decisions frame the revised P4 slices and the P5 measurements. They follow the pattern of comparable always-on agents (Meta Muse, Grok Bot, Manus): a durable host owns conversation semantics, and the harness runs inside the sandbox.

## Ownership

The harness owns only the loop of one attempt. The controller owns everything that must outlive the attempt or commits the product.

| Domain | Owner | Reason |
|---|---|---|
| History and truth | Controller | The guest is untrusted. The controller journal wins over a native transcript, which is only an input to ingest. |
| Compaction between runs | Controller | It defines the projected prefix, so the prompt cache. |
| Compaction inside an attempt | Harness | Needed to survive long computer-use attempts. Its summary is ingested as untrusted data. |
| System prompt | Harness base, controller addendum | The harness keeps its native system prompt, tuned for its own loop and tools. The controller appends a generated Rakazo addendum: identity, bot instructions, text policy, and the tool names as the adapter exposes them. |
| Identity and bot instructions | Controller | Product identity must not depend on the harness. |
| Text policy (narration, `message_user`) | Controller | What a person sees is product behavior. |
| Steering | Shared | The controller decides what and when; the harness inserts it between turns. Optional capability. |
| Sub-agents | Controller | The controller launches every sub-agent as a child attempt with its own projected context, budget, trace and approvals. The harness's own sub-agent launching is not used. |
| Budget (requests, tokens) | Controller | Usage is only measurable at the relay. |
| Approvals and takeover | Controller | A controller tool call that needs approval gets a "pending" reply and is not executed. The controller's pause guard keeps the run paused: further tool calls are answered without running, with a bounded grace for model requests. Once approved, the controller executes the exact action and appends its canonical result. A native guest tool may still run during the grace, see the follow-up decisions. |
| Screenshots and image context | Controller | Pruned at the relay, for every tool result that carries an image, including the harness's native file read. |
| Memory | Controller | Outlives the harness and spans bots. |
| Skills | Shared | The controller converges sources; the harness loads them natively. |
| Trace | Controller | Relay, journal and ingest. Guest claims are not trusted. |
| Retry | Harness for transient model errors, controller for attempts | Harness retries count against the budget. Pause and budget errors are never transient. |

## Run model

A run is a short fork of a canonical mainline held by the controller. Finished runs fold into the text addressed to the person and their recap, as the inference projection already does. There is no persistent native session across runs:

- the prompt cache lives at the provider and keys on prefix bytes, so a new VM does not lose it when the projection is byte-stable;
- a persistent native session would keep every screenshot and tool output of past runs until its own compaction, which costs more tokens for computer use;
- models are chosen by the user across providers, and a native session is tied to one provider's format.

Workers stay disposable (`onTimeout: "kill"`). Sandbox pause and resume gains no tokens; it is a latency option only, not verified on the self-hosted deployment.

## Token efficiency

- Keep the projected prefix byte-stable between runs: move recalled memory, memory context and scratchpad out of the system instructions to the tail of the prompt, freeze what precedes the history until the next compaction, and advance the history window in steps rather than sliding it.
- Memory recall moves to the tail first, and later becomes an on-demand `recall` tool.
- Prune images in batches (keep the last few, evict in blocks) instead of on every turn, so the cached prefix breaks rarely. One setting for all providers.
- Prefix stability works on every provider: explicit cache markers where required, automatic prefix caching elsewhere. No per-provider cache strategy.

## Rakazo tools

Rakazo tools reach the harness through an MCP facade named `rakazo`. The facade runs inside the guest process, one instance per run. It turns each MCP `tools/call` into a P2 `tool.call` frame.

- The controller keeps execution, approval, journal and connectors. The guest only relays.
- No MCP endpoint is reachable on the controller. No token enters the VM.
- The facade core is harness-neutral. Pi plugs in with an in-memory transport. A stdio bridge comes only with a CLI harness, which is outside P4.
- The catalog is frozen at `worker.start`. If a run needs a catalog that changes mid-run, a `tools.changed` frame is the fix. It is not built now.

## Follow-up decisions

- **Tool names.** Each harness adapter supplies its tool naming, and the Rakazo addendum is generated with it, so the names the model reads match the names it calls.
- **Large catalogs.** Use the harness's native deferred loading and tool search when it has one; search, load and execute stay as the fallback for harnesses without it.
- **Context files.** The harness keeps reading `AGENTS.md` from the volume for now.
- **Native tools after a pause.** A native tool called during the grace requests after a pause may still run in the VM. This is accepted: its effect stays inside the VM and the window is bounded.
- **Egress.** Worker egress stays open for now. Filtering through an allowlist proxy is tracked in the infrastructure repository.
- **Native loop.** The native loop is the target architecture. The A/B in P5 measures it but does not gate it. The in-process path will move to the same architecture on the Docker worker provider later.

- **OpenCode.** OpenCode stays on the computer for P4; see the [execution decision](opencode-execution.md).

## P5 measurements

At the relay, per model request: input, cache read, cache write and output tokens; the length of the prefix shared with the previous request of the same thread and bot; and the first divergent section (system, tools, recall, history, image).

Run them on at least one provider with explicit caching and one with automatic caching, on short chained exchanges at several gaps around the cache TTL, on the computer and browser tasks of the A/B protocol, on an approval resumed at short and long delays, and on a forced compaction. A persistent native session is only reconsidered if it beats the stable projection by at least 15% in priced tokens without losing success rate.

## Native Pi MCP integration

The native Pi session loads its MCP and tool-search extensions explicitly. The
`rakazo` server uses only the in-memory facade over the controller channel.
Ordinary product tools are direct; connector catalog entries are deferred until
Pi's `tool_search` loads them. Catalog aliases are normalized to their controller
execution tool in the final transcript, whose results still come from the
controller journal. Harnesses without native search retain search/load/execute.

Screen files use `.rakazo-screen-<random UUID>.png` directly at the private bot
home root. The controller chooses the name; tool arguments cannot choose a screen
write path. Hybrid images use exclusive file creation at the same root. Native
`read` detects the image format from its bytes. Attempt teardown unlinks matching
files and symlinks after the harness has finished, including its final transcript
and pause grace. It leaves directories and other home files alone. The private
volume writer lease must remain held until the guest exits; N13 still verifies
that the real mount root cannot be replaced.

Abrupt VM destruction is an unresolved retention blocker. Guest cleanup cannot
run after a forced kill; the current worker release path destroys the VM and then
frees the volume writer lease without a controller file-cleanup operation. The
volume-files contract has no unlink operation. Completing this guarantee needs a
coordinated cleanup boundary while ownership is still held; this slice does not
change that shared contract.

Offline coverage uses actual Pi sessions and the MCP adapter for deferred
discovery, controller invocation, approval resume after restart, connection
revocation, secret redaction, image reads, and MCP-only runs without a computer
lease. The guest lifecycle owns success, cancellation and failure cleanup tests.
Canonical native/controller replay ordering remains the accepted D9 limitation.
