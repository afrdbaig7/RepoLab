# Getting started

Requirements for the static explorer are Node 24 and pnpm 11. Docker Compose is required for the later disposable-lab workflow. A supported Go toolchain is required to build the supervisor; check `repolab doctor` before trying execution.

```powershell
pnpm install
pnpm build
node apps/cli/dist/index.js init .
node apps/cli/dist/index.js validate .
node apps/cli/dist/index.js analyze .
node apps/cli/dist/index.js open .
```

`analyze` stores application data under `.repolab/data`. The source snapshot is immutable and excludes `.git`, dependency directories, env files, keys, generated files, binaries, special files, symlink escapes, and oversized files by default.
