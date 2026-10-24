# Playwright HTTP caching

Preserve HTTP caching in E2E tests unless the scenario requires request interception.
Playwright documents that both [`page.route()`](https://playwright.dev/docs/api/class-page#page-route)
and [`browserContext.route()`](https://playwright.dev/docs/api/class-browsercontext#browser-context-route)
disable HTTP caching. A narrow RPC pattern still affects caching for the page's assets.
HAR routing and helpers that install routes have the same consequence.

Use the real test backend and existing helpers for ordinary setup. Use request events,
`waitForRequest()`, or `waitForResponse()` to observe traffic without interception.
Fault injection and synthetic responses can justify routing. Document why interception
is necessary and why disabled caching is acceptable at that call site. Existing helpers
such as `showThread()` and `reshapeThreadPages()` rewrite responses and still require routing.

## Phone-navigation benchmark

The phone-navigation spec previously intercepted `me` and `integrationSetup/get` just
to bypass onboarding steps. The scripted runtime already supplies a model, and
`completeOnboarding()` handles the real integrations step. Removing both mocks lets
the navigation scenario use caching without changing its assertions.

A temporary copy of the complete spec alternated the original routed setup and the
proposed real-backend setup in one worker and one harness session. Each test received
a fresh browser context. One warmup pair preceded five measured pairs. Both variants
used the same local Vite server, fake sandbox, scripted runtime, and recording settings.
All 12 executions passed, with no HTTP responses reporting errors.

The full-scenario timer covered routing setup through the final navigation assertion,
including the existing screenshot and fixed wait. Server startup and fixture creation
were outside that timer. The final-navigation timer covered `page.goto("/app")` through
the shell's `data-ready` assertion, before the fixed wait.

| Measurement | With routing, median [range] | Without routing, median [range] |
| --- | --- | --- |
| Complete scenario | 5,323 ms [5,306–5,382] | 5,257 ms [5,213–5,520] |
| Final navigation to ready shell | 294 ms [279–304] | 213 ms [202–250] |
| Existing fixed wait | 3,503 ms [3,500–3,503] | 3,503 ms [3,501–3,504] |
| Resource transfer bytes on final navigation | 16,457,911 [16,457,911–16,542,705] | 48,900 [48,900–48,900] |

Final navigation saved about 82 ms, or 28%. The complete scenario's median improved
by 65 ms, or 1.2%, but its ranges overlap. These runs do not establish a reliable
whole-test speedup or predict a suite-wide improvement.

The measured fixed wait consumes about two thirds of the complete scenario and
limits the possible overall improvement. Resource Timing recorded 250 resources per
final navigation in both variants. Without routing, 87 had a nonempty decoded body
and zero transferred bytes, compared with none under routing. The byte counts cover
Resource Timing entries, not all traffic over the complete scenario.

The machine had other activity during the run. Alternating variants reduced ordering
bias but did not remove that noise. The temporary benchmark spec was removed after
measurement; no permanent benchmark fixture or production hook was added.

Measured pairs, in execution order, with times in milliseconds:

| Pair | Complete with routing | Complete without routing | Navigation with routing | Navigation without routing |
| --- | --- | --- | --- | --- |
| 1 | 5,306.5 | 5,219.0 | 278.6 | 204.9 |
| 2 | 5,345.8 | 5,259.3 | 285.9 | 216.0 |
| 3 | 5,322.6 | 5,520.3 | 294.7 | 249.6 |
| 4 | 5,382.2 | 5,213.2 | 303.9 | 201.9 |
| 5 | 5,319.9 | 5,257.3 | 294.2 | 212.6 |
