# Progress

## Lens implementation - updated 2026-11-05

The controlling direction is now the Lens master prompt. The older RepoLab
checklist below describes preserved functionality, not Lens completion.
See [gap assessment and plan](lens-gap-assessment.md).

Repository: https://github.com/afrdbaig7/RepoLab.git . On 2026-11-05 the user
authorized creating focused commits and pushing this implementation, superseding
the earlier no-push hold. Local Git is initialized on main. Package publication
and GitHub Releases are still separate operations; neither is performed here.

| Gate | Status | Required evidence |
| --- | --- | --- |
| M0 | Locally verified foundation; teaching partial | pinned TS/Cargo, build, overview/source PDFs; inherited annotation gaps remain |
| M1 | Locally verified supported behavior | signature/field/return fixtures, Unicode/CRLF, unchanged and unsupported cases |
| M2 | Locally verified worker/protocol | real Rust Git reads, schema/digest validation, malformed-output and cancellation checks; restricted Windows descendants remain a limit |
| M3 | Scoped project adapter locally verified | captured multi-file Programs, local config inheritance/aliases, trusted libraries, unresolved diagnostics; reference builds/broader syntax unsupported |
| M4 | Eight initial rule IDs locally exercised | six structural/guard/test rules plus resolved local CALL001 and supplied metadata EVIDENCE001; artifact origin remains unauthenticated |
| M5 | Windows x64 local package verified; release gate partial | clean tarball/doctor/Git analysis, atomic output, optional safe source links, bounded I/O, semantic deadline/heap limits; other platforms pending |
| M6 | Implemented; local simulation verified | trusted launcher/event/ref/path checks; hosted fork workflow not executed |
| M7 | Small frozen evaluation executed | original seeded/refactor plus two public scope-boundary PRs; no public positives, broad precision/recall or combined process-tree memory claim |
| M8 | Draft artifacts prepared | contributor/security/changelog/demo/accomplishment docs; independent onboarding/publication gates open |

### Lens checks actually executed

- pnpm build, typecheck and trailing-whitespace format policy: passed locally.
- pnpm verify: passed the full fail-fast local gate. pnpm test passed 73 TS tests
  (57 Lens and 16 preserved RepoLab), with no failed suites.
- cargo test --locked --offline: 2 native tests passed.
- cargo clippy --locked --offline --all-targets -- -D warnings: passed.
- cargo fmt --all -- --check: passed.
- Real Git tests cover divergent policies, dirty-tree isolation, Unicode/CRLF,
  additions/deletions/renames, symlink/submodule/binary/LFS exclusions, shallow
  history, non-UTF-8 Git paths, preserved UTF-8 BOMs and absent/option-looking refs.
- Worker adapter tests reject wrong-version/ID, invalid JSON/UTF-8, oversized,
  truncated/extra output, crashes, excessive stderr, timeouts and cancellation.
- A fresh tarball install passed doctor and six-rule Git analysis with lifecycle
  scripts disabled and no workspace links. Windows x64 only.
- release:prepare passed: final tarball/install smoke, 8 npm and 24 Cargo inventory
  entries, available license notices and archive SHA256SUMS. This is not a complete
  legal audit, standard SBOM or publisher attestation.
- Semantic worker fixtures cover actual compiled execution, deadline/abort cleanup
  and input limits. Project fixtures cover aliases/config/context isolation; artifact
  fixtures preserve untrusted origin even when metadata matches. Source URL and
  trusted-Git-discovery boundaries are tested.
- Seeded demo: six expected observations. Legitimate body refactor: zero findings.
  Actual timing/Node RSS and exact commits are output/evaluation.json, not broad
  accuracy or total process-tree memory claims.
- Frozen Hono PR 3304 and 277 scope-boundary labels were reviewed before execution.
  Both emitted zero supported observations and partial diagnostics, as expected.
  Public positive-label/accuracy denominators are zero; output/public-evaluation
  records timings/counts/limitations and retains the original licenses.
- Learning source digests and regenerated line references are checked. Overview and
  detailed PDF are rendered; representative diagram/code/page transitions inspected,
  with full-document text-margin checks. Remaining teaching gaps are explicit in
  docs/learning/annotation-coverage.json.
- CI is prepared, NOT executed/verified. No Linux/macOS/arm64, hosted fork workflow,
  broad fuzz campaign, external usage or publication is claimed. Docker is not
  available on the current executable PATH; WSL status did not succeed, so Linux
  verification is not inferred from this host.

### Next incomplete milestone

M6's hosted verification is pending the initial source push and workflow results.
The prepared read-only Linux job tests this tool's source; a real consumer fork-PR
test remains separate. Verify exact event refs, summaries/artifacts and stale-run
behavior. No artifact/self-claim substitutes for authenticated workflow metadata.
Other open release gates include remaining detailed annotation coverage, independent
onboarding, broader syntax/compatibility/evaluation, full process-tree memory,
restricted Windows descendant cleanup and crash-time temporary-directory scavenging.

The full master prompt is not complete; these rows separate implemented behavior,
local verification, documentation gaps and unexecuted external release gates.

## Preserved RepoLab progress

Updated: 2026-11-03

## Acceptance checklist

- [x] Workspace and pinned JavaScript toolchain configuration exist.
- [x] Strict manifest schema, safe JSON-path subset, validation, and starter `init` flow exist.
- [x] Bounded local source intake and immutable content-hashed snapshots exist.
- [x] TypeScript/JavaScript static analysis extracts modules, imports, symbols, and supported Express routes with parsed provenance.
- [x] SQLite persistence and graph/source lookup API exist.
- [x] Loopback browser explorer connects to the real control API.
- [x] Versioned framed IPC contract and TypeScript client boundary exist.
- [ ] Go runner compiled and exercised through TypeScript IPC: blocked because the environment's `go.exe` wrapper reports that the real tool is not on PATH.
- [ ] Disposable Docker execution, OpenTelemetry collection, Toxiproxy faults, and example labs: pending runner implementation and Linux verification.
- [ ] Crash recovery, authentication/CSRF hardening, packaging, Playwright, and release CI: pending.

## Checks actually run

- `node --version` → `v24.18.0`.
- `pnpm --version` → `11.20.0`.
- `docker --version` → Docker 29.6.2.
- `docker compose version` → Compose v5.3.1.
- `go version` → blocked: `omnirush: the real tool is not on PATH`.

## Next milestone

Complete the control/API smoke path, then implement the Go framed-protocol server and Linux integration checks once a real Go toolchain is available.
