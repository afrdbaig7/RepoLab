# Runner security boundary

The runner is a private child process. It resolves Docker once at startup and accepts only typed protocol commands. Repository input is not interpolated into a shell, and the protocol has no arbitrary command, host mount, Docker JSON, or exposed port operation.

The current runner build implements the handshake, capabilities, Docker capability check, and bounded cancellation surface. Recipe-specific prepare/start/fault/collect/cleanup operations are intentionally rejected until their plan validation and resource ownership implementation is complete. Rejection is safer than reporting a run that did not execute.
