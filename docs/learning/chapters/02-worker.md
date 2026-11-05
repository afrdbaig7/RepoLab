# Chapter 2: a real TypeScript-to-Rust request

## Milestone snapshot

M2's real worker contributes to reports on Windows x64. Git policies, historical
snapshots and scoped M3 project/alias/configuration context are implemented.
Project-reference builds and broader syntax remain explicit unsupported cases.
See the generated digest and detailed source annotations for this exact snapshot.

## Real wire flow

Commander supplies base/head/repo/policy. Zod validates a request containing
protocolVersion=1, an ID, operation=snapshot and an absolute temporary output path.
JSON.stringify plus a newline produces one bounded request. spawn(binary, args)
launches the trusted executable with shell=false. No path or ref becomes shell code.

Rust main bounds request input, deserializes Request and calls run(&request).
run checks version, operation, policy, directory type/emptiness and absolute roots.
resolve_commit passes ref^{commit} after --end-of-options and validates the returned
hex commit. PR mode requires exactly one merge base; exact mode uses base tip.

snapshot runs NUL-delimited ls-tree with mode/type/object/size metadata. It records
excluded files and enforces tracked-entry, per-file and aggregate bounds. It sends
object IDs to cat-file --batch, verifies each returned identity/size, and slices
the bounded output. Invalid UTF-8/binary/LFS inputs are visible exclusions. Safe
relative target paths remain metadata; only digest-named text files are written.

Manifest serialization ends with complete=true and newline; stdout contains no
logs. A failure emits a structured nonretryable error and exits 2. TypeScript
validates the response's schema, request ID, requested refs/policy, file types,
real paths, sizes and digests. capture finally deletes its temporary resources.

## Why each boundary exists

Removing --end-of-options lets an option-looking ref alter Git behavior. Removing
NUL path separation breaks unusual names. Removing total/file bounds allows memory
exhaustion. Reading the live tree after capture creates mismatched provenance;
the legacy analyzer previously did that and now has a regression test. Hash
verification detects bytes changing between worker production and TS consumption.

The worker clears inherited Git environment, disables global/system configuration,
replacement objects, lazy fetching and fsmonitor/hooks. It never runs target build
tools or initializes submodules. Repository ownership failures remain explicit.
No safe-directory override or credentials are installed behind the user's back.

## Verification actually performed

Rust cargo test passed path/request-boundary tests; clippy with warnings denied
passed. Real temporary Git integration covers divergent policies, committed data
versus dirty checkout, Unicode/CRLF, additions/deletions/renames, exclusions and
missing/option-looking refs. Protocol tests cover malformed JSON, invalid UTF-8,
wrong version/ID, oversized/truncated/extra frames, crashes, cancellation and timeout.

These checks establish the executed Windows path. Restricted Windows descendant
termination, crash-time temporary cleanup and combined process-tree memory remain
limits, not silently green CI boxes. Linux hosted execution is still pending.

## Debugging and exercise

If a request fails, check version/ID first, then worker exit/context, refs and local
history. Never replace a worker failure with an empty findings array. Exercise:
change a ref to --all and explain why resolution fails without becoming an option.
Teach-back: who owns each temporary directory, how are both pipes drained, and
why does a borrowed byte slice remain valid only while its owning Vec lives?
