# Lab manifest

The authoring file is `.repolab/lab.yaml`. It is a strict versioned document. The current schema supports Node applications plus Redis, PostgreSQL, and deterministic HTTP-stub dependencies; scenario assertions are HTTP status, header, bounded duration, JSON-path existence/value, and declared operation occurrence.

JSON paths use a deliberately small subset: `$` followed by dot-separated object keys and non-negative array indexes, for example `$.items[0].name`. Wildcards, filters, expressions, scripts, aliases, and recursive descent are rejected.

Manifest content is data. It does not accept shell commands, arbitrary Compose fields, host mounts, credentials, or unknown extension keys. `validate` reports the manifest location and a correction-oriented message.
