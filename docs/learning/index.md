# Lens learning guide

Study in this order: guide.md, chapters/01-fixtures.md, chapters/02-worker.md,
chapters/03-reports-and-delivery.md, chapters/04-projects-and-provenance.md, then
the generated source walkthrough volume.
The concept index links repeated syntax to its first explanation. The file map
inventories handwritten files and distinguishes inherited documentation gaps.

Generate synchronized source references and check them:

```powershell
node scripts/learning-docs/coverage.mjs
pnpm.cmd learning:check
.tools/pdf/Scripts/python.exe scripts/learning-docs/build.py
```

Create the isolated environment once with python -m venv .tools/pdf and install
scripts/learning-docs/requirements.txt inside it. It is never a product runtime
dependency. PDFs are build artifacts at output/pdf/lens-overview.pdf and
output/pdf/lens-source-volume-1.pdf. Do not assume either exists before generation.
The Markdown sources, annotations and source digests are the versioned record.

Known learning gap: inherited RepoLab/Go files have an inventory and purpose, but
do not yet have full statement explanations. The annotation file records this
explicitly. No milestone with that requirement is claimed completely annotated.
