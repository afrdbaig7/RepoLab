let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const mode = process.argv[2];
const manifest = { schemaVersion: 1, comparison: { requestedBase: request.base, requestedHead: request.head, resolvedBase: "a".repeat(40), resolvedHead: "b".repeat(40), comparisonBase: "a".repeat(40), policy: request.policy }, before: [], after: [], diagnostics: [], totalBytes: 0 };
const response = { protocolVersion: 1, id: request.id, type: "result", manifest, complete: true };
if (mode === "hang") { setInterval(() => {}, 1000); }
else if (mode === "crash") process.exit(8);
else if (mode === "oversized") process.stdout.write("x".repeat(17 * 1024 * 1024));
else if (mode === "stderr") process.stderr.write("x".repeat(65537));
else if (mode === "invalid-utf8") process.stdout.write(Buffer.from([0xff, 10]));
else if (mode === "invalid-json") console.log("not json");
else if (mode === "truncated") process.stdout.write(JSON.stringify(response));
else if (mode === "extra") { console.log(JSON.stringify(response)); console.log(JSON.stringify(response)); }
else {
  if (mode === "wrong-version") response.protocolVersion = 2;
  if (mode === "wrong-id") response.id = "different";
  if (mode === "unsafe-path") manifest.before.push({ path: "../escape.ts", digest: "a".repeat(64), storage: "a".repeat(64) + ".txt", bytes: 1 });
  console.log(JSON.stringify(response));
}
