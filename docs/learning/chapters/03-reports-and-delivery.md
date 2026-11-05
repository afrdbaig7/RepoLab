# Chapter 3: review reports, packages and the trusted Action

## Milestone snapshot

The CLI covers eight initial rule IDs; Windows x64 tarball installation is checked
with the six-observation frozen seeded fixture and separate call/artifact tests.
The Action launcher has local simulation coverage; hosted fork/release validation
is not established. Refer to progress.md for final executed checks and remaining
gates. The generated digest anchors source excerpts without hashing PDFs.

## From report values to display

The JSON renderer preserves original data through JSON escaping. Terminal output
escapes controls so a malicious path cannot clear a screen or create fake lines.
Markdown escapes metacharacters and emits no repository-supplied raw HTML/links.
Offline HTML escapes source and metadata separately, uses native details/summary
for keyboard-accessible disclosure, and includes no remote assets or executable
script. Its restrictive CSP further limits accidental active content.

The renderer does not recompute rules. The same finding has before/after evidence,
priority, strength, limitations and related tests in each display. An HTML source
location is revision/path/range text: no unverified repository URL is invented.

The CLI writes an adjacent exclusive temporary file and renames it to the chosen
destination. Failure removes the temporary file. Config is explicit trusted JSON;
the PR's settings are not loaded automatically. Exit 3 preserves a partial report;
exit 4 is an opt-in findings policy. Default findings do not fail a merge policy.

## Installation and trust

stage-package copies a release Rust binary for the current platform, its exact
version/protocol/digest metadata and original license into the package. pack lists
dist, schema, binary, README and license files. Runtime install has no native
compilation or lifecycle hook. Package authenticity comes from the trusted archive
distribution source; the digest alone is only a corruption check.

package-smoke creates a new project outside workspace links, installs the tarball
with scripts disabled, removes LENS_WORKER, checks doctor, and compares real Git
commits. It caught an ownership mismatch when an elevated smoke run tried to use a
sandbox-owned repository; making its fixture self-contained fixed that test without
weakening Git's ownership boundary. The final smoke completed all six rule checks.

## Action execution and trust

The composite wrapper forwards trusted installation/config locations as data.
run.mjs validates event origin fields and exact commit SHAs, refuses a tool/config
inside target source, clears the developer worker override, and invokes the same
CLI. It bounds/validates reports and checks their resolved refs before writing
workflow summaries and HTML. It has no privileged comment publisher.

Own-source CI is different: it is allowed to build/test changes to Lens itself in
a read-only unprivileged job. A consumer must execute an approved released Lens
tool, not build an analyzer from target PR contents. The prepared CI workflow has
immutable action pins; actual hosted execution is still an open gate.

## Evaluation and honest claims

The frozen fixture JSON includes original MIT source, expected labels and rationale.
demo builds fixed-date commits for the seeded and legitimate-refactor cases. It
records measured time/counts and Node peak RSS, with explicit limitations about
Rust/Git memory. Six expected seeded observations and zero refactor observations
are small controlled denominators, not broad precision/recall or security results.
Two frozen Hono public PRs were also labeled before engine execution. Both have
zero supported observations and partial context; changed arrows or matcher forms
lie outside the initial contract. The public set has zero positive labels, so its
positive precision/recall are undefined. No human review-speed experiment exists.
No adoption or user savings are claimed.

## Answers and small modification exercise

1. Equal annotation text can resolve to different aliases/declarations in different
   projects; our textual comparison does not establish semantic equality.
2. A guard's spelling does not establish its module identity or branch dominance;
   equivalent enforcement can move elsewhere. Its evidence strength is heuristic.
3. Duplicate scoped titles allow multiple possible matches; forcing a pair creates
   misleading assertion changes. Keep the ambiguity visible.
4. A defaulted parameter changes the stored initializer and optional flag. API001
   should fire for a required parameter becoming defaulted, even with unchanged
   text annotation. Add positive and unchanged-default fixtures before altering it.
5. TypeScript capture owns the temporary directory; Rust borrows the requested
   location to produce files. Both process streams are drained concurrently. A
   borrowed slice cannot outlive or mutate independently of its owning Vec.
6. --all is passed as revision data after --end-of-options, so it does not become
   a command option; an absent matching ref fails with a contextual error.

Modification exercise: add an equivalent assertion rewrite fixture and verify the
current textual TEST001 behavior. Explain the false-positive tradeoff before
proposing normalization. Do not change expected labels merely to make a test green.
