# P4 N13 handoff

N13 is incomplete. This draft prepares the native default and records the live results and blockers. It does not close P4 or make the feature ready to merge.

## Implementation

The implementation commit is `ff827ef7eb472bc19863705a8b4dee33b487930e`, based on feature commit `87efaddcff198b87df5189df45fb0e316e49ae5f`. The output/timeout follow-up source is `9c8d15f3dbe07a12c5bbfe36c64e2612c20cbc40`. Other intervening commits add evidence only.

E2B workers now select `pi-native` by default. Repository composition selects `rakazo-worker-pi-native` and enables screen paths. Guest startup and the template builder use the same default. Explicit adapter harness selection still supports `pi`. No shared template was built or published, and this change was not deployed.

The existing P3 runner accepts `--harness` and `--guest`. The latter uploads the guest bundle and read-only managed skills into each owned test worker instead of publishing a template. The model fixture resolves the offered MCP names. The process-isolation lane uses native model progress instead of P2 grants, and the product-computer lane explicitly starts the computer before exchanging files. File-coherence lanes also check that the bot home is the actual mount root and that the guest cannot rename it.

The additional helper lane runs a real native Pi helper in its parent's E2B worker. It checks separate context, one persisted child, an approval with no early effect, controller restart, concurrent resumes, one approved effect, and released attempts. The local model protocol fixture determines the actions. These runs prove runtime and transport behavior, not model intelligence.

## Verification

- The worker, native history, approval, prefix, computer and E2B adapter tests passed: 260 tests in 21 files. The stop fixture explicitly selects its Pi guest rather than inheriting the new native default.
- The existing default-selection tests failed twice when the legacy defaults were restored, then passed all 23 cases after restoration.
- `pnpm check` passed all 24 tasks. `pnpm lint` passed with existing warnings, and the live/guest bundle built. The accepted Expo compatibility exception did not require a dependency change.
- The PostgreSQL integration harness passed 174 tests under its lock.
- The first affected web E2E run passed 217 tests with the five supplied baseline failures. The final run passed 216 with those five plus a 2.46 px approval-button alignment assertion. Geometry and the private-volume baseline were explicitly excluded from investigation. Search-jump remains unverified.
- Test audit retained the existing default and stop contracts. The new live helper lane protects the E2B lifecycle boundary that the offline helper tests cannot reach. It adds no production test seam.

The original SHA-pinned live batch passed 15 of 17 lanes, with zero owned resources left after each lane. [The 45.56-second video](evidence/P4/media/native-runtime.mp4) records file coherence, VM isolation and helper approval recovery; [its poster](evidence/P4/media/native-runtime.png) comes from the actual recording.

The live results are in [lanes.json](evidence/P4/lanes.json), with the tested guest hash and cleanup counts. [verification.json](evidence/P4/verification.json) separates offline proof, live proof and missing lanes. No performance improvement is claimed. Initial provider token counts and screen MCP latency remain unmeasured. The MCP-only lane checks zero computer and volume creation.

The [targeted output/timeout follow-up](evidence/P4/output-timeout-lanes.json) passed both lanes at source `9c8d15f3dbe07a12c5bbfe36c64e2612c20cbc40`. It does not claim that all 17 lanes passed on that source. Native bash now captures its stream with the existing P3 limits and retention, using exclusive private files named `.rakazo-bash-<uuid>.log` directly on the authorized private mount root. Pi still runs the command and owns its status. Its ephemeral spool path and guest-selected directories do not select the retained destination. Runs without a private mount use attempt-local storage. Normal text leaves no retained artifact.

The output lane read all 6,188,895 literal bytes after worker destruction, matched their hash, and checked the advertised path. The model saw 9,906 characters and the canonical result occupied 5,016 serialized bytes. Offline actual-Pi regressions cover a later native read, nonzero exit, command timeout, cancellation, a planted nested symlink, normal text and concurrent helpers on one mount.

The timeout failure came from the validation upload wrapper. An omitted SDK `timeoutMs` extended the sandbox to 300 seconds. It now preserves the existing `endAt`, matching the production adapter. The native lane uses start/completion markers and an explicit recovery inspection; legacy Pi retains its controller deduplication assertions. Live upload deadlines moved by 19 ms and 14 ms, with no reset to 300 seconds. The first attempt ended after 22.8 seconds, released its lease, and a new attempt completed. Exactly one start and no completion marker remained. The installed-SDK loopback regression fails with 300 seconds when the old connect is restored.

Follow-up verification passed 65 focused tests, all 24 typecheck tasks, lint with existing warnings, the bundle and 174 integration tests. Affected web E2E passed 217 with the five supplied baseline failures; search-jump remains unverified. Test audit retained the lifecycle, status, concurrency and serialization regressions as distinct behavior contracts. The two live lanes created five owned sandboxes and four volumes. Four sandboxes were deleted and the timed-out fifth was confirmed absent; all four volumes were deleted. Both final owned censuses were zero.

## Computer parity

The required base is [the canonical computer Dockerfile](../../../infra/sandboxes/computer/Dockerfile), including its apps, browser, capture/page helpers, developer tools, OpenCode and original assets. The I1 computer definition is a plain Node VM. Its tracked source and build workflow exist in the infrastructure I1 worktree under `templates/`; their SDK is older than the application's SDK.

The canonical amd64 image was built locally without changing the Dockerfile. The SDK rejects multi-stage Dockerfiles, so the independently reviewed preparation reuses the immutable image through `fromImage`. [computer-parity.json](evidence/P4/computer-parity.json), [the bootstrap source](evidence/P4/computer-bootstrap.mjs) and [input hashes and modes](evidence/P4/computer-source-digests.json) record that artifact.

The accepted review corrections rename both user and primary group while preserving UID/GID 1000, map the home to `/home/user`, correct only the image cache ownership, preserve mounted data, retain the original startup script, and wait for X:1 and the canonical desktop transport instead of the optional token-gated control server. The builder supplies envd. Managed skills remain read-only with executable scripts. Product desktop preparation accepts the existing ImageMagick capture fallback instead of adding scrot.

Offline Docker checks passed for identity/home/cache, the workspace link, unchanged synthetic mounted-file ownership, actual desktop readiness and capture, app/tool versions and managed skills. They do not prove E2B boot. Parity lanes must use real `E2BSandboxProvider.prepare` through `--prepare-computer`; plain P3 fixtures that skip preparation are explicitly not parity evidence. E2B keeps its `/home/user/rakazo-home` link and dynamic display 20/port 6100 mapping alongside canonical display 1/port 6080.

No authorized image publication/import route was established. The remaining external action is to make the exact immutable canonical image accessible to the builder and build a new E2B computer template from the reviewed source. Publication, import, template creation and infrastructure deployment have not run.

## Remaining work

- Revalidate the final integrated source SHA after the independent catalog/compaction lane commit arrives. Its owner works in a separate checkout and owns only the new lane files. The initial independent review covered `5597938` only.
- Boot and validate the parity computer on E2B, then run the real app/browser form, submission approval, takeover, screen-path read-once/cleanup, and OpenCode job/path/auth lanes. No extra screenshot VM is part of the preparation.
- Run forced compaction and large/deferred MCP catalog, revocation and secret scenarios on E2B. Existing offline tests do not substitute for those live receipts.
- Obtain an authorized generic model connection setup reference before claiming real-model validation. Current live receipts use the local protocol emulator.
- Capture the applicable product flows through the approved screenshot workflow once they run. Unrelated web or phone screens were not substituted. No native mobile screen changed, and no Electron E2E ran.

Normal screen cleanup remains best effort for the exact root `.rakazo-screen-<uuid>.png` namespace. Rare leftovers after abrupt termination are accepted. The stricter admission/runtime/NFS requirements remain abandoned.

The feature stays draft through P6. The changelog belongs to P6. Parent review, CI monitoring and merges remain with the coordinator.
