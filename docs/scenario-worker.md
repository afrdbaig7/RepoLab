# Scenario worker semantics

`@repolab/scenarios` owns the TypeScript HTTP-step and assertion semantics. It evaluates only the manifest assertion subset: HTTP status, case-insensitive header checks, exact JSON-path values/existence, duration bounds, and operation occurrence.

JSON paths are bounded object-property and non-negative array-index chains. There are no wildcards, filters, expressions, scripts, or arbitrary SQL. Missing response bodies, invalid JSON, and incomplete runtime evidence produce `inconclusive`, not a passing result. A failed assertion is separate from runner infrastructure failure.
