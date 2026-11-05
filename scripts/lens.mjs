import { resolve } from "node:path";
process.env.LENS_WORKER ??= resolve(`target/debug/lens-snapshot${process.platform === "win32" ? ".exe" : ""}`);
await import("../packages/lens/dist/cli.js");
