# Approval classification benchmark

This benchmark measures how well a classifier tells consequential connector calls from read-only ones before any change to approval policy. It currently scores the name heuristic, `connectorToolRequiresApproval`. The Decision Model classifier does not exist yet and every report marks it `not-run`.

## Run it

```sh
pnpm exec tsx packages/testkit/src/cli/approval-classification-eval.ts --mode heuristic --split all --output test-report/approval-classification/baseline.json
```

`--mode` is `heuristic` or `model`, `--split` is `all`, `development` or `holdout`, and `--output` defaults to `test-report/approval-classification/<baseline|model>.json`. Unknown options, modes or splits fail before anything is written. The runner makes no network call, opens no database and executes no tool.

The command succeeds only when every selected case received a prediction. Success means the report is complete, not that the classifier meets the gate below. `--mode model` writes an all-`not-run` report and exits with an error, because there is no model yet.

## Corpus

The corpus lives in `packages/testkit/src/evals/approval-classification/`. It has 240 synthetic native and MCP calls, 120 of each label. Development has 160 cases in 62 scenario groups. Holdout has 80 cases in 38 groups, 24 of which contain one of its 25 critical mutations. Each split is balanced on its own.

Each case separates the classifier input from its annotation. The input holds only what production would pass: the public tool name (a catalog wrapper such as `mcp_execute_tool` when reached through the lazy catalog), the resolved tool definition with its description, input schema and optional `readOnly` hint, and the arguments. The annotation holds the expected label, rationale, group, connector, route, stratum (`ordinary` or `adversarial`), critical and ambiguous markers, and any model-independent protection that already requires approval (`gatedElsewhere`). Case ids, groups and labels never reach the input; the CLI refuses a corpus that leaks them.

All services, names, addresses and values are invented. Strings such as `SYNTHETIC-SECRET-MARKER-KV-03` stand in for secrets so later redaction can be checked; none is real.

### Labels

`consequential` means an external effect, a persistent mutation, a send, a publication, a purchase or a change of rights. `read_only` means a read without those effects. Labels follow the behavior each description and its arguments document, never the tool name. Critical marks external sends, payments, deletions and permission changes.

An action whose effects cannot be determined gets the conservative policy label `consequential` with the `ambiguous` marker. That is a policy choice, not a fact, so ambiguous cases are reported in their own cohort.

### Cohorts and the readOnly hint

Only tools without a `readOnly` hint will be sent to the Decision Model. A present hint, `true` or `false`, skips the model and keeps today's name heuristic. The hint is tri-state: absence is not `false`. It never sets the expected label, and checking whether it is present is a metadata lookup, not a classification.

Each case therefore falls in one cohort, reported separately:

| Cohort | Development | Holdout |
| --- | --- | --- |
| `eligible` (no hint, unambiguous, not gated elsewhere) | 139 | 80 |
| `ambiguous` | 4 | 0 |
| `gated_elsewhere` | 9 | 0 |
| `readonly_hint_true` | 4 | 0 |
| `readonly_hint_false` | 4 | 0 |

The hinted development cases are controls, including hints that contradict the documented behavior. The heuristic baseline is measured on all 240 cases.

### Holdout rule

Tune prompts and classifiers on development cases only. Do not open `holdout.ts` or `holdout/` while tuning. The repository is public, so this separation is procedural. `manifest.ts` records the corpus version and a SHA-256 of each split; the CLI fails when the cases no longer match. Any edit needs a new version and hash in the same diff. If holdout results feed back into tuning, publish a new holdout before claiming progress.

### Label review

An implementation agent from the Claude model family authored the corpus. An independent reviewer from the Codex model family inspected all 240 labels and rationales before the first measured baseline. The review corrected five definite mutations previously marked ambiguous, an underspecified code-execution example and contradictory injection text. Outbound-message cases already protected by the executor were excluded from the model cohort or replaced by explicitly adversarial aliases, checked against the real outbound guard. `manifest.ts` records the completed review. A label fix changes the hashes and the version.

## Report

The JSON report identifies the corpus version, both hashes, the label review status and the git commit when available. It contains no tool arguments, connection details or local paths. It lists, for all cases and per cohort, split, connector, route, stratum, risk and group: case counts, not-run counts, true and false positives and negatives, recall, precision, false-positive rate and valid responses, each with numerator and denominator. Not-run cases remain visible in the counts and denominators. All quality ratio values are null for an incomplete bucket, so skipping a mistaken prediction cannot improve its displayed score. Availability is still reported, and complete cohorts retain their own quality ratios. Every miss is listed by id, and every case's prediction is kept for case-by-case comparison.

Variants in one group are correlated. Read failures per group, not only per case.

## Future model gate

Frozen before any model call, on the 80 eligible holdout cases, for each of three independent repeats:

- quality: 0 false negatives and at most 2 false positives;
- availability: 80 valid responses out of 80.

A run with missing responses gets no quality verdict. These are proposed targets on a small synthetic corpus, not a guarantee for real tools; with 40 positives one miss already drops recall to 97.5%. Any revision must be explicit and precede the measurement. The report shows the heuristic against the same gate for information only.

The model classifier will be scored on its raw answer. Provider errors, timeouts and invalid answers will be separate outcomes, and the executor's fallback to the name heuristic will be reported apart from the raw score, so a fallback cannot hide an outage or a wrong classification.

## Limits

The corpus is synthetic and small. Its counts describe these invented tools, not the distribution of real calls. Protocol-derived hints, such as those set by installed API connectors, are not represented; the corpus covers native and MCP tools.
