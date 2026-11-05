# Lens: understand the implementation

## What we have built

Lens compares committed TypeScript source and produces review observations with
exact evidence. It does not run the target or prove that a change is safe. The
current package has eight scoped rule IDs. Read docs/lens-support.md before interpreting
a report. The source digest in the generated inventory identifies the actual
implementation snapshot. PDF builds now record live Git revision and dirty-worktree
status separately from the deterministic, versioned source inventory.

## First principles

A Git commit identifies a tree of paths and immutable object IDs. Reading that
tree is different from walking today's directory. If you edit api.ts after making
a commit, the commit still points to its old blob. Lens resolves refs to commit
IDs first, then enumerates their trees. PR mode selects the shared merge base;
exact mode selects the requested base tip. A missing history object is a failure,
not a successful report with no findings.

A parser turns source characters into a tree. SourceFile owns that AST and knows
how UTF-16 positions map to lines and columns. Program groups source files and
provides diagnostics/binding. CompilerHost decides which bytes the compiler may
read. TypeChecker can distinguish a named import from a same-spelled local
variable. The fixture fallback exposes one captured source with noLib/noResolve.
The CLI now supplies a multi-file captured project, each revision's compiler
configuration, path aliases and bounded strings from trusted TypeScript standard
libraries. The host still performs map lookups only. Project references are not
built and missing modules stay explicit. A textual annotation comparison is not
semantic type equality, even when call declaration resolution is available.

## Types and validation

TypeScript types disappear at runtime. An interface saying a message has a
protocolVersion cannot make a child process obey it. Zod.parse checks actual
values and either returns narrowed data or throws. A discriminated union uses a
literal field such as type=result/error to let the runtime validator and compiler
select the correct branch. Ajv independently validates the generated public JSON
Schema. Path refinements and digest checks add filesystem-specific conditions.

The report distinguishes a Change (structural observation) from a Finding (reason
for review). A finding's priority is not its evidence strength. GUARD001 has high
review priority but heuristic identity: same text need not mean the same function.
No arbitrary numeric risk score hides that uncertainty.

## Execution diagram

CLI -> validated request -> Rust process -> Git objects -> scoped blob directory
-> validated manifest/digests -> isolated AST -> matching -> comparison -> findings
-> validated report -> four renderers.

The overview PDF renders a diagram of this implemented flow. Rust never generates
rules; renderers never rerun analysis. The legacy server/SQLite/Go path remains
separate and is not required to review commits.

## Rust concepts along the actual path

Request owns its String fields. run receives &Request, borrowing it instead of
moving it, so main can keep the request ID for its response. snapshot borrows
&mut usize and &mut Vec<Diagnostic> because it must update shared accounting.
The borrow checker guarantees that these mutable accesses obey Rust's aliasing
rules; no unsafe block is necessary.

Vec<u8> owns bytes. &remaining[..expected] borrows a checked slice instead of
copying a blob. String::from_utf8 can fail, so it returns Result. Option represents
a possibly absent process status; None means the deadline expired in git().
Pattern matching selects successful requests versus parse errors. The ? operator
returns early on an error while converting it to the library Error type.

Serde's Deserialize/Serialize traits convert wire data. derive generates trait
implementations; deny_unknown_fields rejects silently misspelled request fields.
serde(rename_all="camelCase") keeps Rust snake_case fields compatible with JSON.
thiserror derives human-readable errors and conversions without stringly typed
success results. Result<T, Error> makes failure explicit to every caller.

move closures transfer pipe ownership into threads. stdout/stderr readers and the
stdin writer must run concurrently: a process can block writing stderr while its
caller waits for stdout. take(limit+1) bounds storage and detects overflow. join
waits for reader results; a child killed on timeout is waited/reaped. Iterators
sort/map/collect tree data deterministically rather than depending on directory
enumeration order. SHA-256 identities describe content, not trust in its publisher.

## Promises, errors and cleanup

Node spawn creates one worker per comparison. Its stdout events arrive as arbitrary
chunks, not one event per JSON object. invokeWorker accumulates bounded chunks,
waits for close, decodes UTF-8 strictly, and requires one newline-completed frame.
The request ID prevents accepting a response from another run. A Promise resolves
only after validation or rejects with a useful failure. Concurrent stderr draining
avoids pipe deadlock and never prints raw target strings as workflow commands.

capture owns its temporary directory. try/finally removes it after verification or
failure. Stored blob names are digests, not paths supplied by a repository. lstat,
realpath, size and hash checks prevent accidental symlink/path substitution.
Unix cancellation kills the process group; restricted Windows sessions may only
allow direct-child termination. The support document states that remaining limit.

## Concrete input-to-output trace

The original seeded fixture starts with export function save(id: string): string
containing requireOwner(). Its matching head has an optional id, a number return,
and no configured guard call. A vitest test imports save as persist, becomes
skipped, and loses expect(persist('x')).toThrow(). User.owner becomes optional.

The request JSON carries base/head and exact policy. Rust resolves the fixture
commits, ls-tree lists api.ts/api.test.ts, and two cat-file batches return their
bytes. SHA-256 names the stored text. TypeScript verifies these bytes and parses
the strings. The alias symbol identifies persist as the imported save binding.
Matching retains exact path and function/test identity. The result contains
API001, API002, TYPE001, GUARD001, TEST001 and TEST002. GUARD001 lists the related
test with method=static-import-reference and references its two test observations.

The refactor fixture changes only return id to return id.trim(), retaining the
signature, guard and assertions, and produces zero findings. A nonexistent base
ref fails with snapshot_failed and exit 2. Neither result implies general security
effectiveness. output/evaluation.json records actual commits and tiny denominators.

## Debugging order

First run doctor and inspect worker version/platform. Then inspect requested refs,
policy and comparisonBase. On Git errors verify local objects/history and repository
ownership; no automatic fetch or safe-directory override is hidden. On unexpected
facts inspect the syntax matrix and extraction diagnostics. On missing relationships
check named imports, aliases, relative paths and duplicate test titles. On a stale
annotation run learning:check and regenerate line references after updating lessons.

## Glossary

AST: a tree representing parsed syntax. Binding: the declaration an identifier
refers to in its scope. Blob: an immutable Git file object. Completeness: which
stages/inputs were successfully covered, not proof of correctness. Evidence:
revision, path, source range, digest and extraction method. Heuristic: a limited
observation requiring human confirmation. Manifest: bounded metadata locating
snapshot source. Provenance: where data came from and how it was derived. Ref:
a name resolved to a commit before analysis. Schema: the versioned data contract.

## Primary references used for this implementation

The pinned adapter follows the TypeScript Compiler API documentation:
https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API . Rust process
ownership and argument handling follow https://doc.rust-lang.org/std/process/struct.Command.html .
Git tree enumeration follows https://git-scm.com/docs/git-ls-tree . The schema
dialect is specified at https://json-schema.org/draft/2020-12/json-schema-core .
These references inform implementation; executed local tests establish the tested
version's behavior. Current documentation alone does not verify a future compiler.

Node 24 worker/resource and file-handle APIs are documented at
https://nodejs.org/docs/latest-v24.x/api/worker_threads.html and
https://nodejs.org/docs/latest-v24.x/api/fs.html . V8 limits do not include all
external buffers or establish a total process RSS cap; measured memory is separate.
