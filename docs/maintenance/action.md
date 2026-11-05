# Action trust boundary and verification status

The composite Action and run.mjs launcher are implemented. They require an
explicit trusted installed Lens package outside the target checkout. Node 24 must
be available. The launcher never installs/builds the analyzer from PR contents.
It validates GitHub event repository and exact base/head SHAs, rejects
pull_request_target, and invokes the existing engine with PR comparison policy.

Config must be outside the target checkout. LENS_WORKER is removed so PR inputs
cannot redirect execution. The released package's pinned binary metadata is
checked by the CLI. Reports are bounded, validated by the trusted tool schema and
compared to event SHAs before summary/HTML generation. Repository strings never
become workflow command text. No comments/publisher/token/write permissions exist.

Local simulation checks exact revisions, summaries, and rejection of tool/config
paths inside the target and the privileged trigger. This is not a hosted fork
test. A fork test must use pull_request, contents:read only, persisted credentials
disabled, sufficient fetched history/objects, and no target dependency installation.

Use a workflow concurrency group keyed by repository and PR, cancel superseded
runs, and upload each run's JSON/HTML artifacts. Reports stay attached to their
workflow run; there is no shared comment that a stale run could overwrite.

A public minimal user workflow cannot reference a real released Lens identity yet.
Before enabling it: choose/authorize a repository, prepare and approve an exact
release archive plus integrity/authenticity metadata, install it in RUNNER_TEMP,
and pin this composite Action to its reviewed full source commit. Do not replace
that requirement with an untrusted PR checkout or an imaginary release URL.
