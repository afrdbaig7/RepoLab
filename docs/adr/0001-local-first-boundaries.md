# ADR 0001: local-first boundaries and one execution owner

## Decision

RepoLab uses a pnpm TypeScript workspace for the product and one separately supervised Go binary for Docker/Compose execution. SQLite remains under one TypeScript persistence owner. TypeScript-to-Go communication uses private stdin/stdout length-prefixed JSON frames with a versioned schema.

## Rationale

The local control plane can remain useful without an account or LLM key, while lifecycle-sensitive process and container work has one owner with explicit cancellation and reconciliation. Keeping the scenario DSL in TypeScript avoids duplicating assertion semantics in Go.

## Consequences

The runner has no externally reachable port and no product database access. A missing or incompatible runner blocks execution rather than falling back to a fabricated result. Static indexing remains useful without Docker.
