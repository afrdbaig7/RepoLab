import { parentPort, workerData } from "node:worker_threads";
import { compareFiles } from "./compare.js";
import { attachTestArtifact } from "./artifacts.js";
import { loadTrustedLibraries } from "./libraries.js";
import type { AnalysisInput } from "./analysis.js";

const input = workerData as AnalysisInput;
let report = compareFiles(input.before, input.after, input.manifest, input.config, await loadTrustedLibraries());
if (input.artifact !== undefined) report = attachTestArtifact(report, input.artifact, input.after);
if (Buffer.byteLength(JSON.stringify(report)) > 64 * 1024 * 1024) throw new Error("Analysis report exceeds 64 MiB");
parentPort!.postMessage(report);
