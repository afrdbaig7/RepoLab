# Lens (working name)

Local static review of TypeScript Git revisions. MIT. No accounts, uploads, AI keys,
Docker, or target dependency installation. Identifiers have not been checked for
public package/trademark availability. This is an unpublished development package.

```text
lens doctor
lens rules
lens review --repo ./project --base origin/main --head HEAD --policy pr
lens review --repo ./project --base HEAD~1 --policy exact --format html --output report.html
```

Node 24.x and Git are required. A platform-specific Rust worker is staged inside
this tarball. Run `doctor` to verify compatibility. No automatic download occurs.
Other platforms require an explicit source build: `cargo build --locked --release`,
then `node scripts/stage-package.mjs` before packing. `LENS_WORKER` is an explicitly
trusted developer override; never set it from PR content.

Supported: API001, API002, TYPE001, GUARD001, TEST001, TEST002, CALL001, EVIDENCE001. Read
`docs/lens-support.md` in the source repository for the narrow syntax matrix.
Guard calls use text identities. Test associations are static import references.
CALL001 needs supported resolved local targets in both revisions. EVIDENCE001
checks optional --test-artifact provenance metadata; matching claims never
authenticate their producer or establish per-test coverage. Zero findings does not mean safe.

`--base` is required; head defaults to HEAD; policy defaults to merge-base PR mode.
No fetching or working-tree checkout occurs. Config is an explicit trusted local
JSON path: `{"schemaVersion":1,"guards":["requireOwner"]}`. Without `--config`, the
guard list is empty. Target-repository config is never loaded automatically.

Exit codes: 0 analysis complete within the published syntax; 2 failure/invalid
request; 3 partial analysis; 4 optional `--fail-on-findings` policy failure.
Findings do not cause a policy failure by default. Partial reports are written
before exit 3. Machine JSON contains original data; display renderers escape it.

To install a locally prepared archive: `pnpm add /absolute/path/repolab-lens-0.1.0.tgz`.
Use that exact archive for rollback. There is no public release URL yet.
