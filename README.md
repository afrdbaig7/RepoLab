# RepoLab

RepoLab turns a repository into a local, source-linked engineering lab. It combines a bounded static architecture explorer with maintainer-authored executable scenarios, recorded evidence, controlled dependency experiments, and offline reports.

The current implementation is a local-first foundation. It supports Node 24+, pnpm 11+, bounded TypeScript/JavaScript intake, Express route/import analysis, strict `.repolab/lab.yaml` validation, SQLite-backed graph persistence, a loopback Fastify control service, and a browser explorer. The Go supervisor contract and runner module are included as the execution boundary; the Go toolchain is required to enable disposable Docker execution.

## Quick start

```powershell
pnpm install
pnpm build
node apps/cli/dist/index.js init .
node apps/cli/dist/index.js validate .
node apps/cli/dist/index.js analyze .
node apps/cli/dist/index.js open .
```

Open the URL printed by `open`. The explorer shows only facts derived from the selected source snapshot. A repository without a manifest gets a static explorer and no executable run controls.

## Commands

```text
repolab doctor
repolab init [path]
repolab validate [path]
repolab analyze <path>
repolab open <path>
repolab plan <path>
repolab run <scenario-id> [--experiment <experiment-id>]
repolab runs
repolab cancel <run-id>
repolab compare <baseline-run-id> <experiment-run-id>
repolab export <comparison-id> --format html --out <file>
repolab clean --run <run-id>
```

The commands that depend on the Go runner report an actionable diagnostic until a supported runner binary is built and installed. They never substitute fabricated runtime evidence.

## Architecture

See [docs/architecture.md](docs/architecture.md), [docs/manifest.md](docs/manifest.md), and [docs/runner-protocol.md](docs/runner-protocol.md). Static facts are labelled `parsed`; declared manifest facts and future runtime evidence use separate provenance kinds.

## Status

The factual milestone checklist and environment blockers live in [docs/progress.md](docs/progress.md). This repository does not claim production readiness until the release gates in that document have execution evidence.

## License

RepoLab is licensed under the MIT License; see [LICENSE](LICENSE).
