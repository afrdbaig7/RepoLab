# Runner protocol

The canonical protocol description is `packages/contracts/protocol.schema.json`. Frames are a 4-byte big-endian unsigned byte length followed by one UTF-8 JSON object. The maximum frame size is 1 MiB. Stdout is protocol-only; structured diagnostics use stderr.

The handshake includes protocol version, runner version, supported plan versions, platform, and capabilities. Commands are typed and limited to capabilities, prepare/start/fault/reset/collect/cancel/cleanup/reconcile/shutdown. There is no shell, arbitrary Docker command, or host mount command.

Each event includes request, run, attempt, and monotonic decimal sequence identifiers. Unknown fields and malformed frames are rejected before workload start. The TypeScript client treats EOF as interruption, not completion.
