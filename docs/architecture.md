# RepoLab architecture

RepoLab has three boundaries:

1. **Trusted local control plane** — the TypeScript CLI/control service owns SQLite, source snapshots, graph queries, manifest validation, and the private framed IPC connection to the Go supervisor.
2. **Disposable target environment** — target application, fixture services, proxy faults, scenario worker, and telemetry receiver. It cannot call the control service.
3. **Read-only reports** — exported HTML contains escaped, redacted evidence and no execution endpoint.

The current vertical slice completes the first boundary for static intake: the analyzer reads source as data, creates a content-addressed snapshot, extracts bounded TypeScript/JavaScript facts, persists them in SQLite, and serves them to the browser through Fastify. It does not execute repository code.

The execution boundary is intentionally narrow. TypeScript sends versioned length-prefixed JSON frames to the packaged `repolab-runner`; only Go may execute approved Docker/Compose operations. A manifest is compiled to an immutable execution plan and its fingerprint is the trust identity.

## Ownership

- TypeScript: product API, CLI, analyzer, graph, manifest, persistence, evidence normalization, reports, and scenario assertions.
- Go: plan revalidation, process/container lifecycle, readiness, fault activation/reset, cancellation, collection deadlines, and owned-resource reconciliation.

The product never treats static imports as observed calls and never creates runtime results without a real run reference.
