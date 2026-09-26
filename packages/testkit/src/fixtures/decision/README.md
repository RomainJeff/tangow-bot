# Browser decision corpus

Labeled fixture pages for calibrating the two `browser_act` decision thresholds
(`TARGET_PROBABILITY_HIGH`, `OUTCOME_PROBABILITY_LOW`). See
`docs/agent-verification.md` for the commands.

- `cases/`: one JSON file per case, named after its `id`, validated by
  `parseDecisionCase` in `src/decision-corpus.ts`. Target cases label the right
  element by `{ role, name }` or `"none"`, never by ref. Outcome cases hold a
  before and an after page plus the action. Every URL is `https://<name>.test/`;
  the loader refuses anything else. No real site, person or account data.
- `recordings/`: answers recorded from a real provider, keyed by the sha256 of
  each request. Only `answers`, `model` and `usage` are kept.

Families: `distractors` (near-duplicate names, a link and a button sharing a
name, generic names), `density` (20, 40 and 80 candidates, target first, middle
or last, and one past the 80-option cap), `forms` (fields named by label,
placeholder or `aria-label`), `none`, and `outcome` (the five classes;
`boundary: true` marks cases expected to stay `uncertain` rather than be
classified, such as an inline error invisible without page text). Every case
exists in French and English; `targetLang` marks a description written in the
other language than its page. Identical names (five "Learn more" links) are
labeled `none`: the options carry no context to tell them apart.

Limits: element roles and names come from the in-process jsdom session
(`page-browser-session.ts`), not from the Chrome helper (`rakazo-page-browser`);
the two name computations differ at the margins (a `<select>` is named by its
`aria-label` here, not its `<label>`). A recording holds for one model id.

The cases were drafted by an agent and need a human review, especially the
`distractors` labels and the French wording, before a recording is used to set
a threshold: a mislabeled case skews a threshold.
