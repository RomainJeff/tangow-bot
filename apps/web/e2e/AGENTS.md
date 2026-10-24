# Web E2E tests

- Preserve HTTP caching by default. Prefer real backend setup through the existing helpers.
- Use Playwright request routing, including HAR routing and helpers that install routes, only when the scenario requires interception. Add a comment explaining why interception is necessary and disabled HTTP caching is acceptable. Do not install routes in shared automatic fixtures.
- Follow the [E2E guidance](../../../README.md#end-to-end-tests) for alternatives and validation.
