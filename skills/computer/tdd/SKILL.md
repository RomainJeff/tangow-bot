---
name: tdd
description: Test-driven development: write a failing test, make it pass with the least code, then refactor.
---

Use this for any behavior change that can be tested, bug fixes included.

1. Red: write one test that describes the behavior you want and fails for the right reason. Run it and read the failure; a test that passes immediately, or fails on a typo, proves nothing. Put it next to existing tests and follow their naming and helpers.
2. Green: write the smallest change that makes that test pass. No extra parameters, no handling of cases the test does not cover. Run the single test, then the surrounding suite.
3. Refactor: with everything green, remove duplication and name things properly. Run the suite after each refactor step. Do not change behavior here; if you spot one, write a test for it first.
4. Repeat for the next behavior. Keep the loop short: minutes, not hours, between runs.

Rules:

- One assertion topic per test; the name states the behavior, not the method.
- Test through the public surface the caller uses. Avoid mocking what you own; mock the network, the clock and the filesystem edges.
- A bug fix starts with a test that reproduces the bug and fails on the current code.
- Never delete or weaken a failing test to go green. If the test is wrong, say why in the commit.
- Commit when the loop is green; a red state never gets committed.
