# Reviewable release preparation

Nothing has been publicly published. The working package name remains private
until availability and namespace ownership are reviewed. Retain existing MIT
author attribution. Use exact archive filenames for installation and rollback.

Repository: https://github.com/afrdbaig7/RepoLab.git . The user authorized the
initial source push on 2026-11-05, superseding the earlier hold. Local Git now
exists on main. Package publication and GitHub Releases are not part of this push.
Hosted CI/fork verification is reported only from actual workflow results.

## Local commands

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd lens:build
pnpm.cmd build
pnpm.cmd lens:demo
pnpm.cmd package:stage
pnpm.cmd package:smoke
pnpm.cmd release:inventory
pnpm.cmd test
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
node packages/lens/dist/schema.js --check
```

When intentionally changing the authoritative contracts, regenerate artifacts with
pnpm --filter @repolab/lens schema:generate and review their diff. Ordinary build
does not overwrite them, so CI's drift check can detect stale committed schemas.

package:stage builds a release worker for the current platform and stores metadata
beside it. package:smoke packs a tarball, installs in a new temporary project with
scripts disabled, removes developer worker overrides, runs doctor, creates a real
two-commit repository and checks all six rules. It removes that installation on
success/failure. The npm/pnpm cache may need write access outside a sandbox.
pnpm verify runs the fail-fast local build/test/schema/learning gates in order.
pnpm release:prepare runs packaging smoke and inventory/checksum preparation;
neither command pushes or publishes anything.

The prepared archive is output/packages/repolab-lens-0.1.0.tgz. The smoke result is
output/package-smoke.json. Runtime dependencies are TypeScript (AST/compiler cost),
Zod (runtime contracts/schema origin), Ajv (independent JSON Schema validation),
Commander (CLI grammar). Rust dependencies are serde/serde_json (wire data), sha2
(content identity), thiserror (typed errors). Cargo.lock and pnpm-lock.yaml record
the full dependency inventory. PDF dependencies live only in .tools/pdf.

## Gates still required before broad release

1. Execute Linux CI and supported platform matrix; do not extrapolate Windows
   results. Then test clean Linux/macOS/arm64 packages on appropriate runners.
2. Review dependency licenses/notices and produce a complete release SBOM.
3. Review source/package namespace, support policy, changelog and migrations.
4. Verify hosted fork Action behavior and event refs using a real test repository.
5. Review output/release/dependency-inventory.json, retained license notices and
   SHA256SUMS. Obtain provenance/attestations from the trusted release platform.
   Local checksums detect corruption, not publisher identity.
6. Broaden evaluation beyond the two original synthetic and two public scope-boundary cases and measure false
   positives, denominator-specific precision/recall and full process-tree memory.
7. Finish remaining annotation gaps and PDF visual inspection for the release
   snapshot. Record commands/results without inventing hosted execution evidence.

Publishing requires explicit authorization. No workflow here automatically runs
npm publish or creates a GitHub release. Optional future support/hosting belongs
after demonstrated demand and does not restrict the open-source software.
