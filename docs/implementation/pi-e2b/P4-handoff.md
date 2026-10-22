# P4 N13 handoff

N13 is incomplete. NFS locking and product Chrome now pass on a private corrected computer template. This draft records the tested scope and remaining gates; it does not close P4 or promote production defaults.

## Implementation

The implementation commit is `ff827ef7eb472bc19863705a8b4dee33b487930e`, based on feature commit `87efaddcff198b87df5189df45fb0e316e49ae5f`. The output/timeout follow-up source is `9c8d15f3dbe07a12c5bbfe36c64e2612c20cbc40`. The final integrated runtime source is `5ecfcbc9186b5dab3acaa52c333433750fc07d0b`. It includes a normal merge of the two native lane files and registers them in the existing runner. A later assertion-only source, `a554f2875cbccdbbd2b13032597138684bef04f1`, strengthens compaction read proof without changing the guest or product code.

E2B workers now select `pi-native` by default. Repository composition selects `rakazo-worker-pi-native` and enables screen paths. Guest startup and the template builder use the same default. Explicit adapter harness selection still supports `pi`. No shared template was built or published, and this change was not deployed.

The existing P3 runner accepts `--harness` and `--guest`. The latter uploads the guest bundle and read-only managed skills into each owned test worker instead of publishing a template. The model fixture resolves the offered MCP names. The process-isolation lane uses native model progress instead of P2 grants, and the product-computer lane explicitly starts the computer before exchanging files. File-coherence lanes also check that the bot home is the actual mount root and that the guest cannot rename it.

The additional helper lane runs a real native Pi helper in its parent's E2B worker. It checks separate context, one persisted child, an approval with no early effect, controller restart, concurrent resumes, one approved effect, and released attempts. The local model protocol fixture determines the actions. These runs prove runtime and transport behavior, not model intelligence.

## Verification

The historical [integrated runtime batch](evidence/P4/integrated-runtime-lanes.json) passed all 19 registered lanes in one run on `5ecfcbc9186b5dab3acaa52c333433750fc07d0b`. The guest SHA-256 is `b3ace799b31495b1dcdd446864e18c639814cdd204e1937f763e9f0f7b983c3f`; the runner SHA-256 is `aee878d916b1fcb9c9097cf3224b89bfdff35f83f4ca186ef887d97b8f85c523`. Both remote hashes match the local build. Source stayed fixed throughout validation. This is runtime proof with protocol fixtures, without desktop preparation or a real-model intelligence claim.

The catalog lane covers direct and deferred 30-tool schemas, long/colliding SDK names, one approved effect, revoked authority, and redaction of a synthetic controller secret from worker frames, model requests and canonical history. It creates no computer. The compaction lane exercises actual Pi overflow recovery through the relay using low synthetic usage and one controlled overflow response. Two synthetic summary responses lead to a compacted retry; a later attempt uses canonical history rather than the harness summary. This does not prove threshold-only compaction or model intelligence.

The first integrated batch at `c5cbedc0e9f238d70e878a1c9dcef9ffdc2a02f2` passed 18 lanes and failed compaction. Bounded bash output had reduced six fixture results below Pi’s retained-tail split boundary, so it made one summary request instead of two. The failure reproduced offline with actual Pi. Nine bounded results restore the intended split-turn input, with the original approval, pairing, summary and replay assertions intact. The final batch passed all 19 lanes after that fixture-only correction.

Final-source checks passed 48 focused tests, all 24 typecheck tasks, lint with existing warnings, the bundle and 174 PostgreSQL integration tests. Affected web E2E ran the full suite: 216 passed and six failed. Five are the supplied baseline failures; the additional computer-update menu click timed out after becoming unstable and detached, then passed alone in 10.1 seconds under a new lock. Search-jump remains unverified. Integration and E2E each held their lock for one run per acquisition.

All 19 final lanes ended with zero owned resources. Independent API checks confirmed all 51 created sandboxes absent (50 deleted, one expired) and all 41 volumes deleted. The first failed batch independently confirmed 50 sandboxes absent and 41 volumes deleted. Both owned remote scratch directories were removed. Resource IDs remain private. The earlier receipts and video below retain their original SHA and scope.

Historical verification before native-lane integration:

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

## Compaction read proof follow-up

The [targeted read-proof receipt](evidence/P4/compaction-read-proof.json) tests source `a554f2875cbccdbbd2b13032597138684bef04f1`. The prior whole-history marker search could match the write command before any read. It accepted wrong read output, a missing file with exit 1, and correct output followed by exit 1 through actual Pi. All three controls fail the strengthened exact result assertion, and the real read passes. The model request must contain the result paired to `volume-read` with exact `"volume-effect\n"` content; the canonical paired result must also have that exact output and `isError: false`.

Only the actual E2B compaction lane was rerun on this source, and it passed. The guest remains `b3ace799b31495b1dcdd446864e18c639814cdd204e1937f763e9f0f7b983c3f`; the runner is `6bd670202686622e7cdac8f3ae4df67df21d3f7e237115c506c847bf594493c9`. Independent API checks confirmed all three created sandboxes and two volumes deleted, with zero remaining. The owned remote scratch directory was removed. The earlier 19-lane batch remains historical and does not establish the stronger read assertion. No production code changed.

All 24 typecheck tasks, lint with existing warnings and the live bundle passed for the assertion source. Affected web E2E selected the full suite because the impact map was unreadable: 215 passed, the five accepted baseline failures remained, and mention-picker plus computer-update timed out. Both extra specs passed in a separate two-spec run under a fresh lock. The original full run is not green. Root independently accepted the assertion source after reviewing the controls and cleanup. The earlier 174 integration and 48 focused results remain historical and were not rerun for this assertion-only change.

## Real-model computerless task

The [OpenCode Go receipt](evidence/P4/go-real-model.json) records an actual `gpt-6-luna` computerless E2B MCP task at source `066c4c2d7d8d41e9610cbaec8ab3c7fd13ef2c5a`. Three model requests returned HTTP 200, one synthetic inventory lookup executed, and the model answered with its result. The first worker attempt failed because the private limiter dropped Headers entries and omitted the session ID. It performed no effect; the corrected private transport then passed. Both owned workers were released, no computers or volumes were created, and remote scratch was removed. The credential stayed controller-only. This proves neither desktop/vision nor native-file tools nor OpenCode computer jobs.

## Computer parity

The required base is [the canonical computer Dockerfile](../../../infra/sandboxes/computer/Dockerfile), including its apps, browser, capture/page helpers, developer tools, OpenCode and original assets. The I1 computer definition is a plain Node VM. Its tracked source and build workflow exist in the infrastructure I1 worktree under `templates/`; their SDK is older than the application's SDK.

The canonical amd64 image was built locally without changing the Dockerfile. The SDK rejects multi-stage Dockerfiles, so the independently reviewed preparation reuses the immutable image through `fromImage`. [computer-parity.json](evidence/P4/computer-parity.json), [the bootstrap source](evidence/P4/computer-bootstrap.mjs) and [input hashes and modes](evidence/P4/computer-source-digests.json) record that artifact.

The earlier offline review corrections rename both user and primary group while preserving UID/GID 1000, map the home to `/home/user`, correct only the image cache ownership, preserve mounted data, retain the original startup script, and wait for X:1 and the canonical desktop transport instead of the optional token-gated control server. The builder supplies envd. Managed skills remain read-only with executable scripts. Product desktop preparation accepts the existing ImageMagick capture fallback instead of adding scrot.

Offline Docker checks passed for identity/home/cache, the workspace link, unchanged synthetic mounted-file ownership, actual desktop readiness and capture, app/tool versions and managed skills. They do not prove E2B boot. Parity lanes must use real `E2BSandboxProvider.prepare` through `--prepare-computer`; plain P3 fixtures that skip preparation are explicitly not parity evidence. E2B keeps its `/home/user/rakazo-home` link and dynamic display 20/port 6100 mapping alongside canonical display 1/port 6080.

The [actual E2B parity attempt](evidence/P4/computer-parity-live-partial.json) is terminal and incomplete at source `066c4c2d7d8d41e9610cbaec8ab3c7fd13ef2c5a`. The canonical template build, provider finalization, real product prepare, sudo, UID/GID 1000, canonical desktop readiness and cross-VM private/shared mount coherence passed. The dynamic product desktop failed while creating `/home/user/rakazo-home/.browser-profiles`, which resolves into the protected `/workspace` root. No E2B screenshot, native read-image, screen-path cleanup, computer OpenCode job, real-model computer/vision, browser form, submission approval or takeover result was reached. The earlier offline bootstrap receipt above is historical; the actual attempt used the separately reviewed account bootstrap whose hash appears in the live receipt.

Independent scoped API/log recovery confirmed all four runtime sandboxes and all four volumes absent. Attribution of the buddy sandbox and volumes uses the fixture time windows and the exclusive coordinator slot, as the receipt states. The registry container and its anonymous volume, loopback tunnel, extra image tag and remote scratch were removed. One owned ready test template remains for a source-reviewed rerun; its handle and deletion instructions stay in the private handoff. No shared template or deployment changed.

## Browser profile correction

Source `17046afe246df98253acee7710b151c47f2fca10` selects `/workspace/bots/<context.botId>/.browser-profiles` through the existing private-volume path contract. `ComputerRef.botId` and sandbox metadata `botId` remain home keys, which can identify a team. Reconstructed refs detect volumes through existing sandbox metadata. Dedicated and team computers retain hashed per-screen profiles; legacy computers without volumes retain their original profile path. A volume screen without a bot context returns the existing screen-unavailable error.

Export, import and replacement archival enumerate existing private profile directories at their actual `/workspace/bots` paths and the historical root profile directory, then reuse the shared browser stop command. The shared startup/stop owner reads complete NUL-separated `--user-data-dir` arguments from only the existing PID-file and SingletonLock candidates. It accepts the exact path or the same existing directory through an alias, without broadening process discovery. A live dedicated browser started with the historical alias is reused by canonical observe with the same PID, tracking and profile inode. Portable exports exclude caches and locks beneath both root and private profiles while retaining cookies and ordinary project files. Historical root profiles remain available for archival; none are redistributed.

Independent final review blocked initial source `792a7c04dee8f88a3b94c1fd825ba43d99ed71f8`: its dedicated alias pass removed tracking before the canonical pass could find Chrome. A bounded actual-Chrome probe also proved canonical startup could create a duplicate for the same profile inode. Root accepted the independently reviewed shared-owner correction above. The temporary E2B process selector was deleted; fresh independent final review accepted `17046afe` with no material findings and closed P1.

The [offline correction proof](evidence/P4/browser-profile-correction.json) records the final source and bundle hashes, real generated E2B/LinuxDesktop commands executed as UID/GID 1000, old-location permission failure, two stable isolated bot profiles, actual process quiescing, unchanged root ownership/mode, portable export/archive behavior and checks. This is offline Linux permission and adapter proof. That receipt predates the later E2B runs. The private NFS/Chrome candidate below tests the subsequent browser source `9084cb142cf91117fcadf5eb497bea69a745826c`.

Final-source local validation passed 94 focused tests in seven files, including actual Chrome in team, dedicated and historical-alias layouts, plus 174 PostgreSQL integration tests. All 23 non-mobile workspace check tasks passed; the full check failed only on the explicitly waived Expo notification patch mismatch. Lint and the runner/guest bundle passed. Affected web E2E selected the full suite: 216 passed, the five accepted baseline failures remained, and the floating hover-action Copy click timed out. That one extra test passed alone in 8.9 seconds under a new lock after integration finished. The full run remains non-green. Computer-update and mention-picker had no extra failure on this source. Superseded `792a7c04` remains blocked historical evidence, including its different computer-update timeout.

Test audit removed one redundant direct filtering-helper inventory in favor of actual export/archive results. The shared generated-command test rejects another directory with the same basename while stopping a hinted process through an alias. It adds no private predicate export or production test seam. No Electron E2E ran, dependencies were unchanged, and the changelog remains with P6.

## NFS locking and Chrome candidate

The [candidate receipt](evidence/P4/nfs-chrome-candidate.json) records automatic initial mounts and product Chrome on source `9084cb142cf91117fcadf5eb497bea69a745826c`. The tested runtime patch adds `nolock` to the existing envd NFSv3 mount options. The proxy has no remote lock manager; the previous configuration left Chrome's file-lock requests waiting for RPC completion. The [compressed runtime patch](evidence/P4/envd-nfs-local-locks.patch.gz) includes an executable mount-boundary regression and the capability documentation. [Upstream issue 3619](https://github.com/e2b-dev/runtime/issues/3619) reports the same omission; the open report is not a maintainer endorsement.

One private candidate template contains the reviewed binary. Its installed and running envd hashes matched the built artifact, and its first volume mount reported `nolock` and `local_lock=all` without a manual remount. Distinct native processes demonstrated lock acquisition, prompt conflict denial, unlock, and subsequent acquisition within that VM.

Normal product browser navigation, snapshot, fill, click, and capture passed. Full product release closed Chrome; reopening the same persistent profile retained the synthetic cookie and origin local storage. The check endpoint only read those values and the seed endpoint ran once. [The reopened product capture](evidence/P4/nfs-chrome-reopened-product.png) shows both values. This proves synthetic persistence, not authenticated-login continuity, model vision, or the remaining native-MCP approval and takeover flows.

Advisory locks are local to each VM. Concurrent database or browser-profile writers across VMs are unsupported; worker and computer leases do not enforce profile-filesystem exclusion. The profile remains on its persistent private volume.

The candidate build used an isolated image reference with unchanged canonical bytes. The original host envd bytes and metadata were restored after the build. Its one test computer and volume were independently confirmed absent, and the owned registry, tunnel, tag, and scratch were removed. The successful candidate remains private for the remaining N13 tests; the original ready template is unchanged. Production defaults, aliases, and artifact delivery are not promoted by this proof.

## Remaining work

- Finish final evidence and CI review. Independent final review accepted source `17046afe246df98253acee7710b151c47f2fca10` and closed the dedicated-alias P1. The earlier compaction read proof remains pinned to `a554f2875cbccdbbd2b13032597138684bef04f1`.
- Use the validated private candidate for the remaining integrated native-MCP browser, submission approval, takeover, screen-path read-once/cleanup, and OpenCode job/path/auth lanes. Direct product Chrome form, capture, and release/reopen persistence now pass. The native GUI app and remaining integrated gates are unverified. No extra screenshot VM is required.
- Prepare production artifact delivery and computer-template promotion for P6. The private candidate does not change production defaults.
- Keep the computerless Go proof separate from the remaining computer parity and OpenCode job/auth gates.
- Capture the applicable product flows through the approved screenshot workflow once they run. Unrelated web or phone screens were not substituted. No native mobile screen changed, and no Electron E2E ran.

Normal screen cleanup remains best effort for the exact root `.rakazo-screen-<uuid>.png` namespace. Rare leftovers after abrupt termination are accepted. The stricter admission/runtime/NFS requirements remain abandoned.

The feature stays draft through P6. The changelog belongs to P6. Parent review, CI monitoring and merges remain with the coordinator.
