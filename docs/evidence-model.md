# Evidence model

Facts and runtime records carry provenance:

- `parsed`: compiler/source-derived facts and a source reference.
- `declared`: maintainer manifest claims and a manifest pointer.
- `observed`: runtime evidence with a run, trace, or span reference.
- `suggested`: optional future AI output, never an oracle.

Static imports, potential calls, observed operations, and data flow are separate relationship types. Missing telemetry is partial evidence. Assertions are independently checked by the scenario worker; a passing assertion does not certify behavior outside its recorded conditions.
