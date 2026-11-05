# Handoff

## Controlling Lens direction - 2026-11-05

The Lens implementation is in packages/lens, crates/snapshot-worker and
packages/lens-action. Eight scoped rule IDs, snapshot-isolated project context,
bounded/cancelable analysis, four report views and Windows packaging exist.
Use pnpm verify, then pnpm release:prepare and pnpm learning:pdf. See progress.md
for executed results and honest remaining gates; source explanations/digests live
under docs/learning. Local Git is initialized on main.

Repository: https://github.com/afrdbaig7/RepoLab.git . On 2026-11-05 the user
authorized focused conventional commits and the initial source push, superseding
the earlier hold. Do not claim hosted checks passed until their runs complete.
Package/release publishing remains separate. Existing RepoLab/Go features are preserved;
Lens does not depend on them or Docker.

## Preserved earlier RepoLab handoff

## Goal

Build the local-first RepoLab v1 described in the production build brief.

## Current slice

The repository was empty. The first slice establishes the pnpm workspace, strict contracts, bounded analyzer, SQLite store, CLI, control API, browser explorer, runner protocol schema/client, and honest progress tracking.

## Next concrete step

Install or expose a pinned Go toolchain, compile `runner`, and connect the TypeScript runner client to a handshake/capabilities smoke test before implementing Docker lifecycle operations.

## Known blocker

The current environment exposes a Go wrapper but not the underlying Go executable. No Go build or race check is claimed as passed.
