# Lens 0.1 development support contract

Locally verified: Windows x64, Node 24.18.0, pnpm 11.20.0, TypeScript 5.8.3,
Rust 1.92.0, Git 2.47.1.windows.1. Linux/macOS and other architectures have not
been executed here. A prepared workflow is not CI verification.

## Syntax and rules

| Rule | Supported contract | Deliberate limit |
| --- | --- | --- |
| API001 | Unique top-level exported named function; identifier parameters; annotation, name, optional, default and rest structure | No arrows, methods, overloads, generics, destructuring, generators |
| API002 | Both matched functions have explicit return annotations | Text comparison only; annotation addition/removal is a diagnostic |
| TYPE001 | Identifier-named property in a simple exported interface becomes optional | No inheritance, generics, merged interfaces or semantic aliases |
| GUARD001 | Configured dotted text call present before and absent after, within a matched function excluding nested functions | Heuristic; does not establish identity, dominance or authorization correctness |
| TEST001 | Ordered assertion text sequence changes in a uniquely named matched test | Literal imported vitest/@jest/globals test/it and expect; toBe/toEqual/toThrow family; no semantic equivalence |
| TEST002 | Matched active test becomes test.skip/it.skip or test.todo/it.todo | No each, conditional skips, global test names or arbitrary wrappers |
| CALL001 | Resolved local top-level named-function call target sets in matched exported functions | Excluded if either side has unsupported/unresolved calls; no whole call graph or behavioral equivalence |
| EVIDENCE001 | Supplied test-provenance JSON disagrees with actual base/head/config/file digests | No producer/workflow authentication; all artifact associations remain excluded |

Named import aliases are supported. Nested imported describe callbacks contribute
to scoped test titles. Duplicate titles are ambiguous and never forcibly matched.
Static test relationships require a matching local named import binding and an
identifier reference in the callback. This is neither runtime attribution nor
assertion adequacy. Imported alias binding checks prevent local shadow variables
from establishing a relationship. Captured path aliases can also resolve test
references to their actual declaration. Re-export declarations remain outside the
API comparison contract. Assertion reordering/formatting can produce observations.

Functions match by exact path and name. A unique identical content digest can
establish a narrow file rename; an edited rename remains unmatched and partial.
Moves and deletions are visible in diagnostics rather than invented semantic
matches. Unchanged signatures and body-only refactors produce no API findings.

## Snapshots and coordinates

PR policy compares a unique merge-base(base, head) to head. Exact policy compares
resolved base tip to resolved head. All requested/resolved refs and the actual
comparison base are recorded. Missing/shallow objects fail; there is no fetch or
policy fallback. Git replacement objects and lazy fetching are disabled.

Historical paths come from NUL-delimited Git object enumeration, never today's
checkout. Sources are UTF-8, including preserved source BOMs; strict JSON inputs
do not accept a BOM as framing. Invalid UTF-8 paths fail explicitly. Binary content,
LFS pointers, symlinks, submodules, declaration/generated/vendor files and other
extensions are classified as excluded. Therefore a typical mixed repository is
partial, even when all supported TS facts were extracted. No target files are
checked out, executed, installed or changed.

Public coordinates are one-based line and UTF-16 column, end exclusive. Excerpts
are capped at 12,000 UTF-16 code units; source digest and ranges identify the full
source. Rust hashes bytes; TS verifies bytes and decodes UTF-8 before obtaining
coordinates from SourceFile. No Rust byte offset is interpreted as a TS offset.

The CLI builds isolated multi-file Programs over captured source and package/
tsconfig JSON. Root tsconfig.json options, captured relative tsconfig extends and
baseUrl/paths are supported. Both revisions use their own captured compiler config;
review-rule config remains explicit trusted local JSON. Snapshot enumeration is
the analyzed file set; tsconfig include/exclude do not replace that contract.
Project references are diagnosed rather than built/merged; plugins are never
loaded. Outside-root or missing config/dependencies produce partial diagnostics.
The compiler host performs map lookups only. Standard declarations are supplied
from the pinned tool-owned TypeScript installation, with file/total bounds.
The fixture-level extract fallback remains isolated per-file noLib/noResolve.
Unresolved local calls are counted and exclude CALL001 for that matched function.
Trusted built-in library targets are excluded from CALL001's local target set.

## Resource and failure contracts

- Each revision: at most 4,000 tracked entries, including excluded entries.
- Each source blob: 1 MiB; combined source bytes: 32 MiB (both revisions counted).
- Worker request: one NDJSON frame, at most 8 KiB; response: one frame, 16 MiB.
- Worker stderr: 64 KiB; each Git operation: 10 seconds; worker: 90 seconds.
- Rendered output: at most 64 MiB. Snapshot directory is scoped and removed on
  normal success, failure and cancellation. A hard host/process crash can leave
  temporary files; restart scavenging is not yet implemented.
- Stdout/stderr are consumed concurrently. Overflow, truncation, wrong version,
  wrong request ID, unexpected frames, malformed JSON and invalid UTF-8 fail.
- On Unix, cancellation kills the worker process group. On Windows, taskkill /T
  is attempted, with direct-child termination as fallback in restricted sessions.
  Descendant cleanup on restricted Windows sessions needs broader verification.
- CLI analysis runs in one killable worker thread: 60 seconds, 512 MiB old-generation
  V8 heap, 64 MiB young-generation heap, 8 MiB stack. These are V8 bounds, not an
  exact total-process RSS cap. OOM/timeout/cancellation fails explicitly rather
  than returning an empty successful report. Pure library callers own their budget.
- Config and test-artifact reads use file handles with bounded chunks, including
  growth checks and strict UTF-8 decoding. Stat-only checks are insufficient.

No cache exists yet; correctness is measured on the uncached path. No speedup is
claimed from choosing Rust. Files/bytes and end-to-end timing are recorded by the
demo; its Node peak RSS is not combined Rust/Git peak memory.

## Optional test-provenance artifact

--test-artifact accepts at most 64 KiB of strict version-1 JSON with kind
test-provenance, comparisonBase, head, configDigest, and a complete files map of
captured head paths to SHA-256 digests. expectedArtifact(report, headFiles) exports
the exact shape for a separately prepared producer. No target tests are run.
Mismatches emit EVIDENCE001 with supplied-artifact and derived-run-context evidence
methods; their paths are logical metadata resources, not fabricated Git source.
Even matching metadata gets artifact-unverified and is excluded from trusted
associations. This does not consume LCOV, authenticate workflow origin, establish
assertion adequacy or provide per-test execution attribution.

## Contracts and determinism

Zod declarations in packages/lens/src/contracts.ts are authoritative for TS
boundaries. src/schema.ts generates JSON Schema 2020-12 artifacts; --check detects
drift. Ajv validates worker responses, followed by Zod's path refinements. Rust
serde types are explicit mirrors; real cross-language integration checks detect
incompatibility. Rust types are not falsely described as generated.

The report contains Run, Symbol, Change, Finding, evidence and related-test data.
Identity hashes include rule, scope, ranges and source digests. Lists are sorted;
report payloads contain no timestamp. External evaluation metadata contains timing
and machine details. Priority and evidence strength are separate. Report/schema
version 1 is exact; unknown versions fail. Epoch migrations require a new schema.

Terminal and Markdown displays escape controls and repository strings. Offline
HTML uses escaped source, inline CSS and a restrictive CSP, with no executable
script or remote assets. Optional repositoryUrl config accepts an explicit HTTPS
GitHub owner/repository root. Revision-specific links encode each path segment;
before evidence uses comparison-base SHA and after evidence uses head SHA.
End-exclusive ranges become inclusive line anchors. Other hosts/schemes are
rejected and no remote origin is guessed. Artifact context is never linked as Git
code. Without an origin, exact revision/path/range text remains available.
