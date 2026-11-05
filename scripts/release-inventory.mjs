import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { readBoundedText } from "../packages/lens/dist/io.js";

const execute = promisify(execFile);
const manager = process.env.npm_execpath;
if (!manager) throw new Error("Run with pnpm release:inventory");
const javascriptManager = /\.(?:c|m)?js$/i.test(manager);
const dependencyTree = JSON.parse((await execute(javascriptManager ? process.execPath : manager,
  [...(javascriptManager ? [manager] : []), "--filter", "@repolab/lens", "list", "--prod", "--depth", "Infinity", "--json"], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).stdout);
const native = JSON.parse((await execute("cargo", ["metadata", "--locked", "--offline", "--format-version", "1"], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout);
await mkdir("output/release/notices", { recursive: true });
await writeFile("output/release/notices/Lens-LICENSE", await readBoundedText("LICENSE", 65536));
const npm = new Map();
async function recordLicense(name, version, path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isFile() || !/^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(entry.name)) continue;
    const destination = `${name.replace(/[^\w.-]/g, "_")}-${version}-${entry.name}`;
    await writeFile(join("output/release/notices", destination), await readBoundedText(join(path, entry.name), 1024 * 1024));
    files.push(destination);
  }
  return files;
}
async function walk(dependencies) {
  for (const [name, entry] of Object.entries(dependencies ?? {})) {
    const key = `${name}@${entry.version}`;
    if (npm.has(key)) continue;
    const manifest = JSON.parse(await readBoundedText(join(entry.path, "package.json"), 1024 * 1024));
    npm.set(key, { name, version: entry.version, license: manifest.license ?? "not declared", origin: entry.resolved, notices: await recordLicense(name, entry.version, entry.path) });
    await walk(entry.dependencies);
  }
}
await walk(dependencyTree[0].dependencies);
const cargo = [];
for (const entry of native.packages) cargo.push({ name: entry.name, version: entry.version, license: entry.license ?? "not declared", origin: entry.source ?? "this workspace", notices: await recordLicense(entry.name, entry.version, dirname(entry.manifest_path)) });
const inventory = { format: "lens-dependency-inventory-v1", isStandardSbom: false, version: "0.1.0", platform: `${process.platform}-${process.arch}`, npm: [...npm.values()].sort((a, b) => a.name.localeCompare(b.name, "en")), cargo: cargo.sort((a, b) => a.name.localeCompare(b.name, "en")), limitation: "Factual installed runtime/Cargo inventory and available license texts; not a completed legal audit or release-platform attestation." };
await writeFile("output/release/dependency-inventory.json", JSON.stringify(inventory, null, 2) + "\n");
const archive = "output/packages/repolab-lens-0.1.0.tgz";
const checksum = createHash("sha256").update(await readFile(archive)).digest("hex");
await writeFile("output/release/SHA256SUMS", `${checksum}  repolab-lens-0.1.0.tgz\n`);
console.log(`Prepared ${inventory.npm.length} npm and ${inventory.cargo.length} Cargo inventory entries, license texts and archive checksum. Nothing published.`);
