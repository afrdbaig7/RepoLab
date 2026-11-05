# ADR 0002: immutable local snapshots through a Rust subprocess

Status: implemented, locally tested on Windows x64.

Retain the established pnpm/NodeNext/strict-TS/Vitest toolchain and original MIT
attribution. Add one cohesive Lens package and one Cargo worker crate. Splitting
tiny forwarding crates would add indirection without an existing second caller.

Use Git CLI arguments directly, no shell. Two batched cat-file invocations read
both revisions; the executable is not spawned once per file. Request IDs and
versioned NDJSON bind the result to the caller. Content lives in a tool-owned
temporary directory, named by SHA-256 rather than target paths; returned paths
cannot redirect writes into the checkout. This also avoids Windows-unrepresentable
target filenames becoming materialized target paths.

TypeScript performs algorithms and presentation; Rust performs object reads,
classification, hashes and accounting. A checked-in Cargo.lock and 1.92 toolchain
pin make the native build reviewable. Native Node bindings, HTTP, gix, Tokio and
Rayon add costs not justified by measurements of this initial uncached path.

The first slice used an isolated per-file syntax/binding adapter. The next slice
added captured multi-file Programs, bounded trusted standard-library strings,
local config inheritance/aliases and CALL001 declaration-target-set comparison.
Parameter/return annotations are still compared textually, not for type equivalence.
EVIDENCE001 checks supplied run metadata without trusting its producer claims.
Project-reference builds and authenticated/per-test coverage remain outside scope.

Packaging initially includes one exact-platform worker per locally built tarball.
Installed binary metadata pins worker version/protocol and digest. The trusted
package/archive is the source of authenticity; a checksum alone is not a publisher
signature. There are no floating downloads or postinstall execution hooks.
