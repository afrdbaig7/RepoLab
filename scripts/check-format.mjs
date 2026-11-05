import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const roots = ["apps", "packages"];
const violations = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !["node_modules", "dist", "bin"].includes(entry.name)) await walk(path);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      const text = await readFile(path, "utf8");
      if (/[ \t]+\r?\n/.test(text)) violations.push(path);
    }
  }
}

for (const root of roots) await walk(root);
if (violations.length) {
  console.error(`Trailing whitespace found in: ${violations.join(", ")}`);
  process.exit(1);
}
console.log("format check passed (trailing-whitespace policy)");
