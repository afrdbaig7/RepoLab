# Chapter 4: isolated projects, resolved calls and artifact provenance

## Implementation snapshot and prerequisites

This slice extends M3/M4 and hardens M5. Its actual source/config digest is in
annotation-coverage.json and the generated walkthrough. PDFs record live Git
revision/dirty state without creating a versioned hash cycle. Read chapters 1-3 first,
especially AST binding, Result/Promise failures and evidence versus priority.

## One project per captured revision

project.ts receives captured InputFile values and optional trusted library strings.
It maps them into two virtual roots: /__lens_snapshot__ and
/__lens_typescript_lib__. CompilerHost read/file/directory operations are pure map
lookups. No resolution request can fall through to today's disk. Each revision
uses its own captured root tsconfig and package metadata. Relative captured
tsconfig inheritance and baseUrl/paths work; missing/outside config and unsupported
project references/plugins produce diagnostics. Plugins are never loaded.

The analyzed file set comes from the bounded snapshot contract, not tsconfig's
include/exclude. This explicit choice preserves sufficient tracked context and
avoids silently walking a working tree. Captured package.json supplies module
context. The adapter rejects an untested compiler version. libraries.ts loads only
bounded lib*.d.ts strings from the pinned tool-owned TypeScript installation.
Target node_modules, JavaScript configs and build tooling never enter this host.

## What CALL001 actually compares

For a call inside a supported exported function, TypeChecker.getResolvedSignature
locates its declaration. Only unique top-level named function declarations in the
snapshot become local call targets. Imported aliases resolve to the declaration,
not their spelling. Built-in trusted library calls are outside this local set;
unknown/dynamic/unsupported targets are counted and exclude CALL001 for that
matched function. An unknown target never becomes a confident deletion.

The before target set is normalized through verified identical-file renames, then
compared with the after set. Changing an import from first as helper to second as
helper changes the resolved target even though helper() text stays the same.
Renaming first as a to first as b keeps the same target and produces no finding.
This is a static target-set observation, not a complete call graph or behavior
proof. Related tests can also use configured path aliases through actual import
binding/declaration references.

## Artifacts and their limits

--test-artifact accepts strict bounded test-provenance JSON. expectedArtifact
describes the actual comparison base, head, rule-config digest and captured-head
file digests. attachTestArtifact compares those values. A stale head/config/file
map produces EVIDENCE001 with exact original artifact text and a labeled derived
expected context. Its evidence methods are supplied-artifact and
derived-run-context; logical metadata paths are not claimed to be Git code paths.

A self-consistent artifact still cannot authenticate its producer or originating
workflow. It is labeled artifact-unverified, stays partial and is excluded from
trusted test associations. There is no LCOV consumption or per-test tracing.
Requiring a workflow's independently verified identity is a future integration
gate, not a value an artifact can simply assert about itself.

## Killable analysis and bounded reads

The CLI captures and cleans Git blobs, then sends strings/config to one Node
Worker. workerData uses structured cloning, not shared mutable AST objects.
analysis-worker loads trusted libraries and invokes the same comparison engine.
The parent validates the returned report and waits for a clean worker exit.
Timeout, cancellation, invalid result and worker OOM terminate the worker and
reject the Promise. The configured V8 heap/stack limits are not a total RSS cap.
The pure compareFiles API remains usable for fixtures; its caller owns resources.

io.ts opens a file, checks its handle metadata, reads bounded chunks plus one
overflow byte, strictly decodes text and closes in finally. A path's prior stat
is insufficient: symlinks and growing files can bypass a stat-only size check.
The digest/size/root checks still surround snapshot reads. Config/artifacts stay
at 64 KiB. Standard libraries and packaged binaries have separate explicit caps.

UTF-8 source BOMs are retained as characters instead of silently stripped by
TextDecoder. Re-encoding preserves the Git blob's exact digest. Strict JSON inputs
do not silently accept a BOM as framing. Git discovery rejects relative/current-
directory and source-checkout PATH git.exe candidates. Only an absolute executable
outside checkouts is selected, then Rust validates it is outside the target repo.
No candidate is executed to discover trust. This inspection-driven boundary fix
is not a claim that an exploitation experiment was conducted.

Optional repositoryUrl restricts source links to HTTPS GitHub roots. Path segments
use strict percent encoding and exclusive ends become inclusive anchors.
Base/head evidence uses its own commit; logical artifacts never become code links.
Construction is tested; the engine does not fetch every page or guess an origin.

## Actual checks and examples

Project fixtures cover changed direct targets, alias-only refactors, captured
config aliases/extends, outside-root config, missing modules, trusted library
resolution and path-aliased test relationships. A real Git fixture captures
tsconfig and detects CALL001 across commits. Git checks also exercise shallow
history without fetching, raw non-UTF-8 paths, symlink/submodule modes and binary/
LFS exclusions without materializing those target paths.

Artifact fixtures cover stale head/base/config/file metadata, matching but
unauthenticated claims, malformed/oversized/wrong-version inputs and labeled
display. CLI integration checks reports exist before policy exit 4 and partial
exit 3, including EVIDENCE001. Analysis fixtures execute the compiled worker,
terminate on deadline/abort and reject oversized input. Bounded I/O checks exact
UTF-8 size, oversized input and malformed UTF-8. Final counts are in progress.md.

Success: resolved first() changes to second() -> CALL001. Unchanged: imported
target keeps its declaration but local alias changes -> no CALL001. Failure:
outside config/unresolved dependency -> partial diagnostics and no forced call
target comparison. Missing compiler/runtime/worker fails doctor or analysis.

## Questions, exercise and answers

Why must the compiler host not fall back to ts.sys? Because a missing captured
module could otherwise resolve from the working tree or another revision.
Why does matching artifact metadata not prove origin? The artifact can forge its
own claims; only independent authenticated metadata can establish a producer.
Why does canceling a Promise alone fail to stop analysis? The worker keeps running
until explicitly terminated and awaited.

Exercise: add a configured path alias whose target file is absent. Predict a
missing-module diagnostic and skipped CALL001, then add a captured implementation
and verify declaration-target resolution. Keep target dependency installation
disabled. Explain the changed completeness rather than merely updating snapshots.
