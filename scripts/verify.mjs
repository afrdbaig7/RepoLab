import { spawn } from "node:child_process";

const manager = process.env.npm_execpath;
if (!manager) throw new Error("Run this gate with pnpm verify");
const javascriptManager = /\.(?:c|m)?js$/i.test(manager);
const pm = args => [javascriptManager ? process.execPath : manager, [...(javascriptManager ? [manager] : []), ...args]];
const steps = [
  ["cargo", ["fmt", "--all", "--", "--check"]],
  ["cargo", ["clippy", "--locked", "--offline", "--all-targets", "--", "-D", "warnings"]],
  ["cargo", ["test", "--locked", "--offline"]],
  ["cargo", ["build", "--locked", "--offline"]],
  ["cargo", ["build", "--release", "--locked", "--offline"]],
  [process.execPath, ["scripts/stage-package.mjs"]],
  pm(["build"]),
  [process.execPath, ["packages/lens/dist/schema.js", "--check"]],
  pm(["lens:demo"]),
  pm(["test"]),
  pm(["typecheck"]),
  pm(["format:check"]),
  [process.execPath, ["scripts/learning-docs/coverage.mjs", "--check"]],
];
for (const [binary, args] of steps) {
  console.log(`Verify: ${[binary, ...args].join(" ")}`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: "inherit", shell: false, windowsHide: true });
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) { process.exitCode = typeof code === "number" ? code : 1; break; }
}
