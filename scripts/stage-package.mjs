import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const target = `${process.platform}-${process.arch}`;
const name = `lens-snapshot${process.platform === "win32" ? ".exe" : ""}`;
const directory = resolve("packages/lens/bin", target);
await mkdir(directory, { recursive: true });
const binary = resolve(directory, name);
await copyFile(resolve("target/release", name), binary);
await chmod(binary, 0o755);
await copyFile("LICENSE", "packages/lens/LICENSE");
await writeFile(resolve(directory, "worker.json"), JSON.stringify({ version: "0.1.0", protocolVersion: 1, target, sha256: createHash("sha256").update(await readFile(binary)).digest("hex") }, null, 2) + "\n");
console.log(`Staged ${target}; only this platform is included. No binary was published.`);
