# Chapter 1: a fixture becomes an evidence-backed finding

## Milestone snapshot

M1 behavior is locally verified; the generated source digest anchors this chapter
to actual code. PDF builds record live Git revision/dirty metadata. Read contracts.ts,
extract.ts, compare.ts and fixtures.test.ts in the detailed source volume.

## Values and responsibilities

InputFile contains path, UTF-8-decoded content and revision. extract returns
functions/interfaces/tests plus diagnostics. Evidence captures one-based public
lines/UTF-16 columns, original excerpt and fileDigest. The code obtains node start
positions from SourceFile; a Rust byte count never becomes a TS character offset.

Function parameters become ordinary objects with name/type/optional/rest/default
fields. JSON structural comparison detects a supported parameter change. Explicit
return annotations use text comparison and are labeled accordingly. A missing
annotation is not inferred from runtime behavior. Unsupported generic/destructured
or overloaded declarations produce diagnostics rather than confident empty facts.

Map provides name-indexed fields and imports. Set keeps call/reference observations
unique. A visit skips nested function bodies for guard presence: a helper's guard
does not show that the outer function calls that guard. That still says nothing
about control-flow dominance, branch coverage or authorization correctness.

The test parser accepts imported framework functions and literal scoped titles.
The binder checks identifier identity so a shadowed local persist is not the
imported function. Ordered assertion text is deliberately narrow: an equivalent
rewrite can still deserve inspection and may produce a false positive.

## Matching, negatives and failures

Same path/name matches first. A unique identical-blob rename is safe enough to
carry identity across a file rename. Edited moves and duplicates remain ambiguous.
Before/after evidence stays attached to its own revision. Structural Change and
review Finding records have separate IDs, even where the first rules emit both.

Positive: id:string becomes id?:string -> API001. Negative: return id becomes
return id.trim() with unchanged signature -> no API finding. Boundary: malformed
source -> parse-error/partial, no fabricated signature comparison. Test fixtures
also cover Unicode/CRLF, explicit returns, fields, guards and ambiguous titles.

## Actual verification and its limit

pnpm.cmd --filter @repolab/lens test ran seven fixture tests successfully during
the first slice. Later protocol/Git/render/Action tests extend the suite; consult
docs/progress.md for the final count. These tests establish supported behavior,
not public-PR precision, whole-program semantics or behavioral equivalence.

## Decisions and exercises

Pure compareFiles takes values, so fixtures need no filesystem/process mocking.
Adding a server or runtime test execution here would obscure static evidence.
TypeScript 5.8.3 stays pinned behind the adapter; changing it requires rerunning
fixtures and binding-isolation checks, not selecting an untested latest compiler.

Teach-back: Why can equal type text still mean different semantics? Why is a
configured call name heuristic? Why should duplicate test titles stay unmatched?
Exercise: add a fixture where a default value makes a parameter optional and
predict API001. Answers are in the final answers section of chapter 3.
