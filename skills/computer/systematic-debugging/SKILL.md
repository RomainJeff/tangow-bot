---
name: systematic-debugging
description: Fix bugs by reproducing, isolating and finding the root cause, then locking it down with a regression test.
---

Use this when something is broken and the cause is not already obvious from the error.

1. Reproduce. Get a reliable, minimal way to trigger the failure: a command, a test, an input. If it only fails sometimes, find what makes it deterministic (seed, order, timing) before going on. Quote the exact error.
2. Read the evidence before theorizing: the full stack trace, the logs around it, recent changes (`git log -p --since=... -- <path>`). The first frame is rarely the cause; walk up to the first frame in code you own.
3. Form one hypothesis and test it with the cheapest experiment: a log line, an assertion, a narrower input, bisecting (`git bisect` works well when a known-good commit exists). Change one thing at a time and keep notes of what you ruled out.
4. Isolate. Shrink the reproduction until removing anything else makes the bug disappear. That boundary is usually the cause.
5. Find the root cause, not the symptom. "Add a null check here" is a symptom fix if the null should never have been produced. Ask why the bad state exists and fix it there; check other callers that share the path.
6. Write a regression test that fails on the old code and passes on the fix. Then run the whole suite: the fix must not move the bug elsewhere.
7. Clean up: remove debug output, keep the test, explain cause and fix in the commit message in plain words.

If after a real effort you have no hypothesis left, stop and report what you know: reproduction steps, what you ruled out, where the trail goes cold. That is more useful than a guess.
