# Computer runtime

Tangow keeps the agent runtime and the computer runtime separate:

```text
chat/API -> worker (Pi native) -> Tangow computer tools -> SandboxProvider -> E2B
                                                     |-> Docker
                                                     |-> fake

SandboxProvider workspace <-> AgentHomeStore <-> Tangow-owned DATA_DIR
```

Every run starts Pi in a short-lived worker of its own: an E2B sandbox or a Docker container, with the bot's and the space's files on volumes. Tangow tools and model keys stay in the Tangow process (see [E2B workers](self-host-e2b-workers.md)). The built-in tools are ordinary Pi tools, not Claude- or MCP-specific tools, so any model exposed through Pi can call them. Screen operation still requires a model that can accept image tool results and reason about screenshots.

## Computer contract

Each workspace gets one Team Computer by default. Bots share its files and installed tools. Each Team bot starts in `bots/<bot-id>/`, while deliberately shared work belongs in `shared/`. These folders organize work but are not security boundaries: every Team bot can access the full Team workspace. A bot can instead use a Private Computer, where the whole workspace is its home.

Each active Team bot gets its own X display and Chrome process, with a persistent Chrome profile keyed to the bot's identity. Logins, cookies, and browser history are independent. Profiles are never cloned from another bot, merged, or deleted when a desktop is released. Both bots keep their changes; reopening a bot uses its existing profile even when its display slot changes. Team runs use fenced per-bot database leases: different bots can operate concurrently, and one bot has only one computer driver at a time.

Docker and E2B use the same Linux desktop lifecycle commands. Adapters share allocation, observation, actions, and control handling; provider code supplies command execution, persistent workspace paths, and screen URLs. View and control use separate revocable websocket capabilities; teardown disconnects clients before a display slot is reused. A failed teardown keeps the slot reserved for retry.

Desktop stacks start lazily when a bot uses graphical tools. There is no configured desktop cap by default; a computer can host 100 or more bot profiles, and simultaneous desktops are bounded by its RAM, CPU, process capacity, and available local debugger ports. Docker operators can set a positive `SANDBOX_TEAM_SCREEN_LIMIT` to cap active desktops (`0` leaves it unset). Requests beyond an explicit limit return `MULTI_SCREEN_UNAVAILABLE`; shell and file tools remain available. All desktops share one token-protected screen gateway, so adding desktops does not require publishing more ports. Each view/control capability targets a unique local Unix socket; recycling a display cannot redirect an old connection to its next bot. Inactive bots do not each run Chrome. Closing a viewer leaves the desktop intact. A Docker computer keeps a bot's desktop and Chrome after a run that completed or is waiting for an answer, so the bot's next run, a helper's follow-up or a person's takeover finds the page it left. Only the run's control is revoked; the view link keeps working. The kept desktop closes after the idle delay (`SANDBOX_IDLE_MS`) through a per-bot `computer.screen-sleep` job that waits while the bot has a queued, leased, running or takeover run or a person holds control, and that the supervisor refuses when a newer run has taken the desktop. A kept desktop still counts against the desktop limit until then. Failed, cancelled and interrupted runs, a bot's deletion, and providers other than Docker release the desktop at once. When a bot's Chrome starts again, it restores the tabs of its last session from the bot's profile. Whole-computer idle shutdown stops remaining processes while preserving the workspace. Persistent profiles consume disk but do not require a running Chrome process.

`SandboxProvider` is the provider boundary. A backend must implement:

- lifecycle: provision/reconnect, stop, and destroy;
- desktop: observe, ordered batched actions, user input, and a live screen session;
- execution: commands inside the machine;
- files: list/read/write plus complete workspace import/export.

On supported graphical computers the model gets `browser_navigate`, `browser_snapshot`, and `browser_act` for page text and element refs. The default `computer` browser provider drives the visible Chromium tab through the sandbox's optional `pageBrowser` contract. Docker implements that contract through the same managed-screen and lease checks as desktop controls; update the computer image to install the helper. Other providers keep their existing desktop tools until they implement the contract. No hosted browser service or API key is required.

The computer container is the security boundary. Team bots share the OS user, workspace, browser profiles, and shell/X11 access; screen leases coordinate tool calls, not mutually untrusted processes inside that computer. CDP binds only to the container's loopback interface and is not published as a host port. Use separate computers when workloads require isolation.

The helper uses an isolated script world, masks password values, and rejects stale refs instead of retargeting replacement elements. Snapshots include bounded page text and up to 80 interactive elements; a drop-down also lists up to 30 of its enabled option labels (80 characters each, `optionsTruncated` past that) and reports the chosen option's label as its value. Frames and unsupported interactions require desktop tools. A failed action reports confirmed progress and whether its outcome is uncertain: inspect the current state before continuing and never replay completed or uncertain actions automatically. For models without vision, request takeover if page tools cannot operate.

### `browser_run`

When the Space has a decision provider connected (**Settings → Decision Model**, see [self-hosting](self-host.md)), the model also gets `browser_run(goal, values?, maxSteps?)` and is told to delegate multi-step page tasks to it. Until `browser_run` has been tried in the run, `browser_act` answers with a pointer to it; it opens once `browser_run` stops for a confirmation, a block, the step limit, or no usable provider, or fails, so the model can confirm or get past it by ref. A missing value never opens it: the model calls `browser_run` again with the value in `values`. The Space connection is resolved again at each `browser_run` call, so a disconnected or replaced key stops receiving page state from the next call on. The backend then drives the current page in a bounded loop: at every step it takes one snapshot and makes one decision call that picks the operation (`click`, `fill`, `select`, `wait`, `done`, `blocked`) and, speculatively for each available operation, its target: a clickable element, a (field, value name) pair built from `values`, or, for a drop-down, one of its own options, so a duration or a category the caller did not provide is picked from what the page offers. Only the chosen operation's target is validated and used, and it must reach a probability of 0.80, or 0.60 with at least twice the probability of the next element, so two equivalent buttons ("Continue" and "Next") do not stop the loop. The action goes through the same `act` as `browser_act`, one step at a time, never replayed. A disabled element (`:disabled` or `aria-disabled="true"`) is listed and marked `disabled` in the snapshot but never offered as a target, and after each fill or select the loop waits 300 ms before observing again, so a button the page enables once a field holds a value is seen.

The loop stops and returns to the model with `status` `done`, `needs_input` (`need.kind` `value` when a text field, or a drop-down without listed options, needs a value that `values` lacks, `confirm` before a consequential click), `blocked` (the provider said so, no fitting element after two short waits for the page to settle, a target short of that gate with up to three ranked `candidates`, three steps without a page change, the same control a third time within six steps, an uncertain or repeatedly failed action), `step_limit` (default 25 steps, at most 40, or 120 seconds), or `unavailable` (no usable provider or page before the first step). The result lists the steps (operation, element role and name, value name or option label, success), the final URL and title, and the final page's elements so the model continues by ref. A click on a control named like pay, buy, order, book, confirm, delete, send, submit, publish, subscribe, or sign (English or French), is never taken: the model confirms it with `browser_act`. Password fields are never offered for typing.

The decision provider receives, per step, the goal, the page URL and title, up to 4 000 characters of page text, the provided values (at most 120 characters each), the element table with current field values (at most 120 characters, never passwords), and the last 10 steps, all after run secrets are redacted. `browser_run` is one tool call for approvals, the loop guard, effects (one per call, uncertain if interrupted), the screen lease, and the workspace checkpoint. Logs carry counts only (`agent.decision.call` with purpose `run_step`, `agent.browser.run` with status, steps, decisions, duration, tokens, and cost); exported traces nest a `decision step N` generation per step under the `browser_run` tool span.

Fake computers and explicit `BROWSER_PROVIDER=fake|emulator` use an in-process session for tests. These sessions are not the live logged-in browser. Browser mutations share the existing teaching guard and workspace checkpoint flow. `computer_observe`, batched `computer_act`, `open_path`, `launch_app`, `shell`, and file tools remain available according to the computer and model capabilities. Identical consecutive desktop frames keep their metadata but omit duplicate image bytes from model context.

Human input and agent input may coexist on distinct Team screens. “Take control” grants the user an exclusive control lease on that bot’s screen so the embedded viewer accepts input. For a Team bot, takeover is refused with HTTP 409 (“Stop the bot first”) while that bot holds a live computer execution lease or an active run, unless the run is `waiting_takeover` (the bot asked for protected input). Stop the bot first, then take control; after release, the agent may continue. `request_takeover` remains available when the model explicitly needs protected input or human judgment.

## E2B backend

The E2B adapter uses `@e2b/desktop` for machine lifecycle, shell commands, files, and port URLs. Every bot desktop uses the shared Linux runtime, including the first bot. Its X display, screenshots, input, and view/control transports follow the same lifecycle as Docker.

The database stores the provider kind and opaque `providerRef`. That reference is an acceleration path, not durable data. It is passed back only to the same provider kind. A missing machine or a provider-kind change creates a replacement and restores its workspace through the provider-neutral contract.

## Developer tooling

The Docker computer image ships `git`, GitHub CLI (`gh`), Node.js LTS with npm and Corepack (`pnpm`, `yarn`), `build-essential`, Python with `pip` and `venv`, `ripgrep` and `fd`. The desktop terminal is Xfce Terminal with zsh as the login shell; its defaults live in `/etc/tangow/zshrc`, which the seeded `~/.zshrc` sources, so edits to `~/.zshrc` persist. Shell tool commands still run under `bash -c`. Bots run without root, so further tools go into the workspace: `npm install -g` and `pip install` land in `~/.local`, which persists with the home.

[OpenCode](https://opencode.ai) is installed in the image (version pinned in `infra/sandboxes/computer/Dockerfile`). Run `opencode auth login` in the computer's terminal once; the token lives in `~/.local/share/opencode/` in the persistent home and is excluded from `backup-prod.sh` archives. Skills versioned in the repository's `skills/` directory are mounted read-only at `/managed-skills`; `start.sh` links `/managed-skills/computer` to `~/.config/opencode/skills` so OpenCode loads the `computer` family (see `skills/README.md`).

To let a bot use GitHub, store a token as the `GH_TOKEN` agent secret. It reaches every shell command, `gh` reads it, and git uses `gh` as its credential helper for `https://github.com`, so `git clone` and `git push` over HTTPS work without per-repository setup. On a Team Computer every bot in the workspace shares that token; prefer a fine-grained token scoped to the repositories the bots need. The E2B computer template is built from the same image, so it includes this tooling.

## Persistence

The portable computer workspace is the durable boundary. E2B uses `/home/user/tangow-home`; Docker and local providers expose the equivalent home. Browser profiles are rooted under `.browser-profiles` in that workspace on E2B. Tangow checkpoints transferred workspaces into `AgentHomeStore` at run completion or failure, before explicit stop, and before idle suspension. Docker mounts the Tangow-owned home directly and only advances its revision marker at those boundaries. New or replacement machines import the latest stored workspace before use.

A computer whose home is on volumes skips this checkpoint. Its bots' folders live on each bot's private volume and the shared folder on the space's volume, and the computer and the run workers mount the same volumes at `/workspace/bots/<botId>` and `/workspace/shared`. New spaces start on volumes. Existing E2B homes move once, as [E2B workers](self-host-e2b-workers.md) describes; existing Docker homes move by themselves, as [homes on volumes](self-host-sandbox-providers.md#homes-on-volumes) describes. A Docker computer keeps `/home/tangow`, with its dotfiles and browser profiles, on its home directory.

`LocalAgentHomeStore` currently keeps the latest workspace under `DATA_DIR/homes/<computer-home-key>` and checkpoint metadata separately under `DATA_DIR/home-revisions`. Replacements are staged before the current copy is swapped, and checkpoints are serialized per computer. This implementation is latest-only rather than an immutable revision archive. Production deployments must put `DATA_DIR` on a Tangow-owned persistent volume, encrypt that volume at rest, and include it in off-host backups. The storage interface is deliberately independent of E2B so an object-store-backed implementation can replace the local volume without changing agent tools or sandbox providers.

Before exporting a remote workspace, remote backends quiesce desktop browsers so profile databases and login state are copied consistently. Run checkpoints defer while another bot holds an execution or user-control lease; the last finishing run or idle job saves the shared workspace. Idle shutdown claims the computer before exporting, preventing a new bot from starting during the snapshot. They exclude only transient cache/lock files inside `.browser-profiles`; similarly named project files remain durable.

The disposable OS image is not a portable disk snapshot. System packages installed outside the workspace are lost when moving to another provider; durable machine customization should be represented by a reproducible image or setup recipe. This is what makes a future backend switch practical instead of trying to translate vendor-specific VM snapshots.

## Verification

Offline tests cover tool-result images, action parsing, provider conformance (including the page-browser adapter and computer_act fallback), workspace checkpoint/restore, provider SDK translation, lifecycle integration, and the multi-screen E2B emulator. They never call a model or live sandbox.

The live vision acceptance test (`pnpm test:computer`) drove the in-process agent loop and was removed with it.

### Docker desktop lifecycle regression

Build the computer image, then run `VERIFY_DOCKER_TEAM_SCREENS=1 pnpm exec vitest run infra/sandboxes/supervisor/src/team-desktops.docker.test.ts`. Set `TANGOW_COMPUTER_IMAGE` to select a prebuilt image. The test uses an isolated Docker container with networking disabled and fake browser state; it verifies parallel Chrome desktops visiting local fixture sites, independent cookies, profile persistence after release, transport teardown, and rejection of old view/control tokens after slot reuse. It runs both Docker supervision and the command path used by remote providers. Default unit tests exercise profile persistence, allocation, and lease fencing offline without Docker.

## Computer maintenance

Update and recovery run as durable background jobs. A computer-wide reservation
excludes new execution leases, stop, takeover, idle suspension, and computer-mode
changes while the operation saves and replaces the workspace. Progress is stored
separately from the computer's provisioning fence. Web and Electron show a dialog
or compact background pill; mobile uses a native sheet. Reopening the app restores
active operations and failures from the API.

Update explicitly rebuilds with the configured provider/image; `canUpdate` means
the computer supports that action, not that a newer image was detected. Provider
migration and image-version discovery are not part of this UI. Updates checkpoint
live work before teardown. Recovery can fall back to the last saved workspace,
so its failure action warns that unsaved work may be lost.

The reconciler republishes queued operations after a missed enqueue. Jobs already
claimed are never destructively replayed. A worker that stops heartbeating for ten
minutes is marked interrupted and remains reserved until its provider calls settle.
Only then is recovery available. If a worker has permanently disappeared, an operator
must stop the affected workers and verify that provider operations have stopped before
using the server-owner-only **Release computer** action in the interrupted dialog.
Its confirmation requires an explicit assertion that workers and provider operations
have stopped, then makes normal recovery available. The corresponding RPC is
`computer/releaseInterrupted` with `{ id, workersStopped: true }`; it accepts only
interrupted operations in the owner’s current workspace. A stale heartbeat alone
never authorizes takeover. Progress reports
actual lifecycle stages rather than estimated percentages; workspace files and
browser profiles are portable, while system packages outside the workspace are not.
