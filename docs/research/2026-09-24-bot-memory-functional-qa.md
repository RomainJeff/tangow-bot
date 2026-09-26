# Bot memory classification — functional verification

## Scope

Verify the local web application with synthetic demo data and the configured live providers. Separate UI workflow results, semantic examples and deterministic authorization tests. This is not an accuracy benchmark or proof of prompt-injection immunity.

## Observed in the browser

- Bot Settings → Classification accepts a Markdown method and prepares a versioned criterion with the requested choices: Protocole, Compte rendu, Décision.
- Explicit consent is shown before method preparation and before the first judgment call.
- A reusable interview preparation procedure is suggested as Protocole by the live judgment provider.
- Human validation persists an annotation attributed to the bot and method version.
- Changing the suggestion to None and validating persists the human correction.
- Revoking that correction persists Learning stopped after reload.
- A synthetic interview report containing an instruction to answer Décision and validate automatically is suggested as Compte rendu. Human validation remains required. This is one adversarial example, not a general security guarantee.
- The adversarial test memory was withdrawn after inspection.

- From the bot conversation, an explicit classify_memory request returns a Protocole suggestion and an internal review link. Opening the link loads the saved suggestion with Validate and Cancel; no automatic validation occurs.

## Finding

Multiple successive reviews from the same bot and version are displayed together without a clear current/history distinction. After revoking the latest review, an older review remains visible with its learning action. The learning selector separately uses the latest review per question and the regression test verifies that an older correction is not resurrected. The UI nevertheless makes this behavior ambiguous. Recommended follow-up: one current annotation per bot, with prior reviews behind History and an explicit distinction between annotation and learning eligibility.

The conversational response also recaps unrelated older remember/recall results despite an explicit request for only the current classification result. This is a response-focus issue; the recap alone does not establish that those older tools were executed again.

## Deterministic boundary verification

All 11 bot-method PostgreSQL scenarios pass in a disposable test database: independent bots, method versions, stale runs, private and cross-space access, separately shared methods and corrections, revoked feedback, provenance, invalid answers, exact-run links and legacy row preservation.

## Limits

Only the web UI was exercised interactively. Native mobile behavior, broad classification accuracy and longitudinal learning improvement were not measured.
