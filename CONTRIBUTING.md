# Contributing

Use Node 24.x, pinned pnpm 11.20.0 and Rust 1.92. Read docs/lens-support.md and
docs/maintenance/release.md before changing the review engine. Run the local build,
fixture, Rust, protocol, schema and package checks described there.

For a rule change, first add positive, legitimate-refactor negative and unsupported
fixtures. Keep extraction facts separate from comparisons and renderers. Findings
must include exact revision/path/range evidence, comparison method, limitations
and a useful next inspection step. Never infer security correctness from guard
presence or label static references as runtime attribution.

Add the rule contract to docs/lens-support.md, update the learning chapter and
source digests, regenerate/inspect the PDF, and describe checks actually executed.
Use small reviewable changes; preserve MIT attribution and unrelated RepoLab code.
No arbitrary executable target configuration or rule plugins are accepted.
