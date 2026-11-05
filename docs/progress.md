# Progress

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
