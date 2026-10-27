# Computer-use helper on a browser task

Does a bot finish a multi-page browser task better when it hands the work to the managed `computer-use` helper than when it drives the browser itself? On one task, with one model, both ways succeeded 5 times out of 5. The helper way was about 30 seconds slower. It left the bot with about 10 000 fewer context tokens and spent about 100 000 fewer tokens in total.

Five trials per variant only show large gaps. The context and token gaps are wider than the run-to-run spread, and so is the wall-time gap. A small gap between these numbers would be noise.

## Setup

- **Model.** GLM 5.3 Flash (`glm-5.3-flash`) through OpenCode Go, connected with the shared `opencode-go` provider. Bot and helper ran the same model. Pi's catalog declares that the model reads images, and a probe with a screenshot confirmed it.
- **Computer.** A new Docker computer per trial, built from this branch. Its first `browser_navigate` took 5.0 to 5.4 seconds in every trial, which is a cold desktop each time. The bot's own `bash` ran in a Docker worker with no route to the computer's loopback.
- **Site.** A static travel site in `packages/testkit/src/bench/travel-site/`, served on the computer's loopback only. It has a search with destination, departure month and day range, results four per page, a page per circuit with its itinerary and departures, and a quote form that shows the total for 2 adults, booking fee included, once the form is filled. The distractors are a cheaper circuit with no Hiroshima, a cheaper circuit that leaves only in March, and an April circuit whose "from" price is lower than the answer's but whose April departure costs more.
- **Task.** "On the travel site at http://127.0.0.1:8765/, find the 10 to 14 day Japan circuit departing in April that visits Kyoto and Hiroshima at the lowest price. Give its name, its total price for 2 adults, its duration and its link." The grader checks the reply literally for Rising Sun Discovery, 5600 (separators allowed), 13 days, and `/circuits/rising-sun-discovery.html`.
- **Variant A, direct.** The bot has the computer and browser tools and no `run_subagent`, so it cannot delegate.
- **Variant B, helper.** The bot is not offered `computer_*`, `browser_*`, `open_path` and `launch_app`, through the `mainBotBlockedTools` option of `createApp`. It hands the work to `computer-use`.
- **Order.** A then B, five times, through `pnpm test:evals --live --computer docker --case browser-direct --case browser-helper --trials 5`. Each trial uses a new account, thread, bot and computer.
- **Not offered.** No decision provider was connected, so neither variant had `browser_run`.

## Results

Wall time runs from the message to the end of the bot's last run. Main context is the input of the bot's last model call. Total tokens add the bot and its helper.

| Metric | A direct, median (min to max) | B helper, median (min to max) |
|---|---|---|
| Success | 5/5 | 5/5 |
| Wall time (s) | 71 (58 to 84) | 102 (88 to 125) |
| Time to first reply (s) | 66 (54 to 79) | 85 (11 to 110) |
| Main bot context at end (tokens) | 24 737 (23 932 to 25 518) | 14 675 (14 143 to 14 963) |
| Total tokens, bot and helper | 441k (245k to 516k) | 342k (290k to 373k) |
| Main bot tool calls | 21 (12 to 24) | 3 (3 to 6) |
| Total tool calls | 21 (12 to 24) | 24 (22 to 27) |

Raw rows, in run order:

| Trial | Variant | Success | Wall time (s) | First reply (s) | Main context at end | Total tokens | Main tool calls | Total tool calls |
|---|---|---|---|---|---|---|---|---|
| 1 | A direct | yes | 68 | 60 | 24 330 | 435 834 | 21 | 21 |
| 2 | B helper | yes | 98 | 11 | 14 794 | 370 321 | 5 | 26 |
| 3 | A direct | yes | 58 | 54 | 23 932 | 245 487 | 12 | 12 |
| 4 | B helper | yes | 112 | 110 | 14 675 | 342 063 | 3 | 23 |
| 5 | A direct | yes | 84 | 79 | 25 518 | 516 162 | 24 | 24 |
| 6 | B helper | yes | 102 | 98 | 14 143 | 289 864 | 3 | 22 |
| 7 | A direct | yes | 74 | 70 | 25 490 | 471 194 | 22 | 22 |
| 8 | B helper | yes | 88 | 85 | 14 158 | 332 356 | 3 | 24 |
| 9 | A direct | yes | 71 | 66 | 24 737 | 440 541 | 21 | 21 |
| 10 | B helper | yes | 125 | 16 | 14 963 | 373 227 | 6 | 27 |

## Why the variants differ

**Wall time.** Model calls bound both variants. Tool execution took 8 to 16 seconds of each trial, and model calls with their streaming took the rest. B makes more sequential model calls, 24 to 30 against 13 to 25, for three reasons. First, the bot tried to reach the site itself before delegating, with `bash` in 4 trials and `web_fetch` in 2, and delegated after 10 to 23 seconds. Second, the helper took 19 to 21 page steps in 69 to 92 seconds, about as many as the direct bot took. Third, the bot then wrote the answer from the helper's report.

**Time to first reply.** The helper did not cause this gap. In trials 2 and 10 the bot posted a short "looking now" message before delegating. In the other three B trials, and in every A trial, the first reply was the answer. With so few trials, the median follows that choice.

**Main bot context.** In A every snapshot stays in the bot's history, so its last call carries the page text of every page it read. In B the bot's history holds its brief and the helper's report, about 2 000 tokens above the 12 700 tokens of its first call.

**Total tokens.** Each model call re-sends the caller's whole prompt and history. A bot call averaged 18 700 to 20 500 input tokens in A, because the bot's prompt and tools come to 13 400 before it reads any page. A helper call averaged 11 100 to 12 500, because the helper's first call carries about 5 200: its profile, its brief and its own tools. B makes a few more calls, but each one costs less.

**Tool calls.** The total is about the same because the browsing is the same work. B moves it out of the bot: the bot made 3 to 6 calls, of which `run_subagent` and the final `message_user` are always 2.

## Helper instructions

The `computer-use` instructions were tuned on three development tasks on the same site, never on the benchmark task. They read one circuit's itinerary, list the Vietnam circuits of 8 to 10 days with their prices, and get a quote for 2 adults. Each variant ran each task 3 times. The table counts the helper's tool calls apart from the bot's.

| Variant | Instructions | Success | Helper tool calls, median (min to max) | Total tokens, median (min to max) |
|---|---|---|---|---|
| v0 | The one-line example profile | 9/9 | 7 (4 to 14) | 102k (84k to 238k) |
| v1 | Tool contracts, work rules, report format | 8/9 | 4 (3 to 28) | 101k (86k to 684k) |
| v2 | v1, plus browser tools only for reading pages, stop once the pages answer, and a description that names the browser | 9/9 | 4 (3 to 19) | 100k (87k to 407k) |
| v0, rerun after the timeout fix | as v0 | 8/9 | 5 (0 to 10) | 98k (91k to 143k) |
| v2, rerun after the timeout fix | as v2 | 9/9 | 4 (3 to 14) | 86k (71k to 267k) |

v2 is frozen. Its helper takes about 4 steps where v0's takes 5 to 7. In the v0 rerun that failed, the bot never delegated and told the user it had no browser. v2's description names the browser, and no v2 bot answered that way.

A defect skewed the first three rows. The guest's MCP client gave the model a timeout after 60 seconds while a sync helper kept working. Two runs had a helper longer than 60 seconds. In the failed v1 run the bot called `run_subagent` without a profile, so its helper had no browser and ran 115 seconds without reaching the site. In one v2 run the helper took 89 seconds, and the bot started a second one. No v0 run went past 60 seconds. After the fix (`timeout: 0` on the guest's Rakazo MCP server), v0 and v2 were rerun once each, and the reruns gave the same ranking.

## Limits

- One task, one model, five trials per variant. A gap smaller than the spread above is no measurable difference.
- The computer runs an amd64 image under emulation on an arm64 host. That makes page steps slower than on a native host for both variants alike.
- B blocks `open_path` and `launch_app` besides `computer_*` and `browser_*`. Otherwise the bot opened the page on a desktop it could not see.
- The bot could read the site's HTML through `computer_exec` in A, or through the helper in B. The direct bot did so in trial 3.

Reproduce with `pnpm sandbox:build`, then the command in [Setup](#setup) with `--connection <private-json-file>`, as [agent verification](../agent-verification.md) describes.
