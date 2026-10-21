# Setup: getting OpenCode ready

Goal: the user never opens the computer. Do as much as you can yourself, give them one simple action at a time, and run `<oc> doctor` again after each step.

## `<oc> doctor` states

| Output | Meaning | What you do |
|---|---|---|
| `state=ready` | OpenCode works and has a model account | Continue with the brief. |
| `state=no_credentials` | OpenCode has no model account | Sign-in by code, below. |
| `state=no_opencode` | OpenCode is not installed on the selected computer | Say so plainly; offer to do small changes yourself, or ask the admin to use a computer with OpenCode. |
| `github=missing` | GitHub is not connected | Fine for local work. Needed only for private repositories and pull requests: see GitHub below. |
| `bash: ... No such file` | The selected computer has no managed skill mount | Use a computer with the managed skill mount. Direct code work can still use the worker tools. |

Run all setup commands on the computer through `computer_exec` in worker runs, or `shell` in the in-process harness. A missing OpenCode binary in the worker is expected. Do not install it there as a repair. Keep the job-directory override from SKILL.md on every `oc` call.

## Sign-in by code (preferred)

Ask which account the user has, in plain words: "To write code I need an AI account. Do you have ChatGPT Plus or Pro, or GitHub Copilot?" Then:

- ChatGPT Plus/Pro: `<oc> login openai`
- GitHub Copilot: `<oc> login copilot`

The command prints `url=` and `code=`. Send them to the user:

> Open this link on your phone or computer: <url>
> Type this code: <code>
> Sign in, approve, and tell me when it says it's done. The code expires in 15 minutes.

When they say done, run `<oc> doctor`. Still `no_credentials`: run `<oc> login` again for a fresh code and ask them to retry; after two failures, use takeover. `state=login_failed`: retry once, then takeover.

Anthropic (Claude) accounts have no sign-in by code: the key must be typed on the computer, so use takeover.

## Takeover (last resort)

Use `request_takeover` with a reason a non-developer understands, then give exact steps:

> I need you to type one command on the computer, it takes a minute.
> 1. Click on the terminal window.
> 2. Type `opencode auth login` and press Enter.
> 3. Pick your provider with the arrow keys, press Enter, and follow what it asks (paste your key if it asks for one).
> 4. Tell me when it's done.

Then run `<oc> doctor` again. Never ask them to paste a key in chat; if they do anyway, tell them to revoke it and create a new one.

## GitHub (private repositories and pull requests)

Needed when `github=missing` and the repository is private or the user wants a pull request. Prefer the GitHub sign-in by takeover: terminal, `gh auth login`, choose GitHub.com, HTTPS, "Login with a web browser", and follow the code it shows. If the user prefers a token, explain where to create one (GitHub, Settings, Developer settings, Fine-grained tokens), to limit it to the repositories you need, and that it is typed on the computer, never in chat.

## Repository not on the volume

For a public repository, clone with native worker `bash`: `git clone <url> /workspace/bots/<id>/<name>`. For a private repository using the computer's GitHub sign-in, run the clone through `computer_exec` into that same volume path. Computer credentials are not available in the worker. If sign-in is missing, set up GitHub on the computer first.
