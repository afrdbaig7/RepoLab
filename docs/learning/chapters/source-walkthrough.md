# Detailed source walkthrough - volume 1

Implementation source digest: d53d8283461d6fd3954ddbd5e19bc67c6c9bf867f37dbe9a7f4e9c0ab4ea2349. PDF builds capture live Git revision/dirty status separately.

Read concepts in the overview first. Numbered source lines are extracted from the actual files, not retyped examples. Each grouped explanation states local runtime purpose and the consequence of losing a boundary. File/test overviews are deliberately marked as incomplete statement coverage. The PDF displays non-ASCII source characters with explicit Unicode escapes for print-font compatibility; the versioned Markdown and source retain the original UTF-8 text.

## crates/snapshot-worker/src/main.rs

Source digest: acb1f73aac7f5296cb341342f1f331bc829518dd79e43515038cd4cfbf42f60f. 501 lines. Explanation level: statement-groups.

### Lines 1-15

Unsafe code is forbidden. Imports name the wire traits, digest implementation, owned buffers, paths, process handles, threads and clocks. Constants bound snapshots, files and tracked entries before allocations grow unbounded.

```
   1 #![forbid(unsafe_code)]
   2
   3 use serde::{Deserialize, Serialize};
   4 use sha2::{Digest, Sha256};
   5 use std::fs::{self, OpenOptions};
   6 use std::io::{self, Read, Write};
   7 use std::path::{Component, Path};
   8 use std::process::{Command, Stdio};
   9 use std::thread;
  10 use std::time::{Duration, Instant};
  11
  12 const MAX_BYTES: usize = 32 * 1024 * 1024;
  13 const MAX_FILE: usize = 1024 * 1024;
  14 const MAX_FILES: usize = 4000;
  15
```

### Lines 16-25

Error is an enum: invalid contract/resource state, I/O or JSON failure. thiserror provides Display and From conversions so ? preserves failure without fabricating success. Borrowed static messages avoid leaking source or credentials.

```
  16 #[derive(Debug, thiserror::Error)]
  17 enum Error {
  18     #[error("{0}")]
  19     Invalid(&'static str),
  20     #[error("I/O operation failed: {0}")]
  21     Io(#[from] io::Error),
  22     #[error("JSON contract failed: {0}")]
  23     Json(#[from] serde_json::Error),
  24 }
  25
```

### Lines 26-78

Request owns strings; deny_unknown_fields rejects unknown keys and camelCase aligns Rust fields with TS JSON. Serialize structs describe commits, bounded file metadata, exclusions and the combined manifest. Integration tests validate actual emitted messages against the TS/JSON contract.

```
  26 #[derive(Deserialize)]
  27 #[serde(rename_all = "camelCase", deny_unknown_fields)]
  28 struct Request {
  29     protocol_version: u32,
  30     id: String,
  31     operation: String,
  32     repo: String,
  33     git: String,
  34     output: String,
  35     base: String,
  36     head: String,
  37     policy: String,
  38 }
  39
  40 #[derive(Serialize)]
  41 #[serde(rename_all = "camelCase")]
  42 struct Comparison {
  43     requested_base: String,
  44     requested_head: String,
  45     resolved_base: String,
  46     resolved_head: String,
  47     comparison_base: String,
  48     policy: String,
  49 }
  50
  51 #[derive(Serialize)]
  52 struct File {
  53     path: String,
  54     digest: String,
  55     bytes: usize,
  56     storage: String,
  57 }
  58
  59 #[derive(Serialize)]
  60 struct Diagnostic {
  61     code: &'static str,
  62     stage: &'static str,
  63     message: &'static str,
  64     path: String,
  65 }
  66
  67 #[derive(Serialize)]
  68 #[serde(rename_all = "camelCase")]
  69 struct Manifest {
  70     schema_version: u32,
  71     comparison: Comparison,
  72     before: Vec<File>,
  73     after: Vec<File>,
  74     diagnostics: Vec<Diagnostic>,
  75     total_bytes: usize,
  76 }
  77
  78 // Drain both pipes concurrently. Each buffer and Git operation has a hard bound.
```

### Lines 79-81

git borrows repo/argument strings and owns input bytes for its writer thread. Command launches Git directly. Clearing environment and selectively restoring OS process requirements prevents inherited GIT_* variables redirecting analysis.

```
  79 fn git(request: &Request, args: &[&str], input: Vec<u8>, limit: usize) -> Result<Vec<u8>, Error> {
  80     let repo = &request.repo;
  81     let mut command = Command::new(&request.git);
```

### Lines 82-110

Fixed config/environment disables system/global config, prompts, replacement objects, lazy fetch, fsmonitor and hooks. Arguments are separate values, not shell interpolation. All three standard streams are piped.

```
  82     command.env_clear();
  83     for key in ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"] {
  84         if let Some(value) = std::env::var_os(key) {
  85             command.env(key, value);
  86         }
  87     }
  88     command
  89         .env("GIT_CONFIG_NOSYSTEM", "1")
  90         .env(
  91             "GIT_CONFIG_GLOBAL",
  92             if cfg!(windows) { "NUL" } else { "/dev/null" },
  93         )
  94         .env("GIT_TERMINAL_PROMPT", "0")
  95         .env("GIT_NO_REPLACE_OBJECTS", "1")
  96         .env("GIT_NO_LAZY_FETCH", "1")
  97         .env("GIT_OPTIONAL_LOCKS", "0")
  98         .args([
  99             "--no-pager",
 100             "-c",
 101             "core.fsmonitor=false",
 102             "-c",
 103             "core.hooksPath=/dev/null",
 104             "-C",
 105             repo,
 106         ])
 107         .args(args)
 108         .stdin(Stdio::piped())
 109         .stdout(Stdio::piped())
 110         .stderr(Stdio::piped());
```

### Lines 111-135

Owned pipe handles move out of Child into concurrent threads. Each reader stores at most its bound plus one overflow byte. The writer consumes the owned input Vec and then closes stdin.

```
 111     let mut child = command.spawn()?;
 112     let stdout = child
 113         .stdout
 114         .take()
 115         .ok_or(Error::Invalid("missing Git stdout"))?;
 116     let stderr = child
 117         .stderr
 118         .take()
 119         .ok_or(Error::Invalid("missing Git stderr"))?;
 120     let mut stdin = child
 121         .stdin
 122         .take()
 123         .ok_or(Error::Invalid("missing Git stdin"))?;
 124     let output = thread::spawn(move || {
 125         let mut bytes = Vec::new();
 126         stdout
 127             .take((limit + 1) as u64)
 128             .read_to_end(&mut bytes)
 129             .map(|_| bytes)
 130     });
 131     let diagnostic = thread::spawn(move || {
 132         let mut bytes = Vec::new();
 133         stderr.take(65537).read_to_end(&mut bytes).map(|_| bytes)
 134     });
 135     let writer = thread::spawn(move || stdin.write_all(&input));
```

### Lines 136-156

Polling try_wait distinguishes completion from the 10-second deadline. Timeout kills and waits the child. A brief sleep avoids a busy loop. Joining readers/writer returns their errors and bytes after the process has ended.

```
 136     let started = Instant::now();
 137     let status = loop {
 138         if let Some(status) = child.try_wait()? {
 139             break Some(status);
 140         }
 141         if started.elapsed() > Duration::from_secs(10) {
 142             let _ = child.kill();
 143             let _ = child.wait();
 144             break None;
 145         }
 146         thread::sleep(Duration::from_millis(5));
 147     };
 148     let bytes = output
 149         .join()
 150         .map_err(|_| Error::Invalid("Git stdout reader failed"))??;
 151     let errors = diagnostic
 152         .join()
 153         .map_err(|_| Error::Invalid("Git stderr reader failed"))??;
 154     let written = writer
 155         .join()
 156         .map_err(|_| Error::Invalid("Git stdin writer failed"))?;
```

### Lines 157-171

Timeout, output overflow, nonzero exit and writer failure become errors. Stderr content is not reflected as raw terminal text. Only successful bounded stdout returns to the caller.

```
 157     if status.is_none() {
 158         return Err(Error::Invalid("Git operation exceeded 10 second timeout"));
 159     }
 160     if bytes.len() > limit || errors.len() > 65536 {
 161         return Err(Error::Invalid("Git output limit exceeded"));
 162     }
 163     if !status.is_some_and(|value| value.success()) {
 164         return Err(Error::Invalid(
 165             "Git failed; verify repository, commit refs and local history (no automatic fetch)",
 166         ));
 167     }
 168     written?;
 169     Ok(bytes)
 170 }
 171
```

### Lines 172-192

References are length/control checked and resolved with rev-parse --verify --end-of-options plus ^{commit}. Returned text must be a supported hex commit ID. Option-looking names cannot become Git options.

```
 172 fn resolve_commit(request: &Request, reference: &str) -> Result<String, Error> {
 173     if reference.is_empty() || reference.len() > 1000 || reference.chars().any(char::is_control) {
 174         return Err(Error::Invalid("invalid revision reference"));
 175     }
 176     let expression = format!("{reference}^{{commit}}");
 177     let result = git(
 178         request,
 179         &["rev-parse", "--verify", "--end-of-options", &expression],
 180         vec![],
 181         1024,
 182     )?;
 183     let sha = String::from_utf8(result)
 184         .map_err(|_| Error::Invalid("invalid commit encoding"))?
 185         .trim()
 186         .to_owned();
 187     if !matches!(sha.len(), 40 | 64) || !sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
 188         return Err(Error::Invalid("invalid resolved commit"));
 189     }
 190     Ok(sha)
 191 }
 192
```

### Lines 193-204

Relative normal components are required. Parent/absolute/drive/backslash paths fail. Unusual UTF-8 names, spaces and newlines can remain metadata because target path names are never used as storage paths.

```
 193 fn safe_path(value: &str) -> bool {
 194     !value.is_empty()
 195         && value.len() <= 1000
 196         && !value.contains(['\\', '\0', ':'])
 197         && !value
 198             .split('/')
 199             .any(|part| part.is_empty() || part == "." || part == "..")
 200         && Path::new(value)
 201             .components()
 202             .all(|part| matches!(part, Component::Normal(_)))
 203 }
 204
```

### Lines 205-238

ls-tree uses full-tree recursive NUL records and sizes. Every tracked entry counts toward the bound. Metadata and UTF-8 paths are validated before supported files enter the batch.

```
 205 fn snapshot(
 206     request: &Request,
 207     sha: &str,
 208     total: &mut usize,
 209     diagnostics: &mut Vec<Diagnostic>,
 210 ) -> Result<Vec<File>, Error> {
 211     let tree = git(
 212         request,
 213         &["ls-tree", "--full-tree", "-r", "-z", "-l", sha],
 214         vec![],
 215         4 * MAX_FILE,
 216     )?;
 217     let mut entries: Vec<(String, String, usize)> = Vec::new();
 218     let mut seen = 0;
 219     for row in tree.split(|byte| *byte == 0).filter(|row| !row.is_empty()) {
 220         seen += 1;
 221         if seen > MAX_FILES {
 222             return Err(Error::Invalid("snapshot exceeds 4000 tracked entries"));
 223         }
 224         let tab = row
 225             .iter()
 226             .position(|byte| *byte == b'\t')
 227             .ok_or(Error::Invalid("malformed Git tree"))?;
 228         let metadata =
 229             std::str::from_utf8(&row[..tab]).map_err(|_| Error::Invalid("invalid Git metadata"))?;
 230         let path = std::str::from_utf8(&row[tab + 1..])
 231             .map_err(|_| Error::Invalid("non-UTF-8 Git paths are unsupported"))?;
 232         if !safe_path(path) {
 233             return Err(Error::Invalid("unsafe or unsupported Git path"));
 234         }
 235         let columns: Vec<&str> = metadata.split_whitespace().collect();
 236         if columns.len() != 4 {
 237             return Err(Error::Invalid("malformed Git tree metadata"));
 238         }
```

### Lines 239-284

Symlinks, submodules, generated/vendor and unsupported extensions become counted diagnostics. Supported blobs must satisfy per-file and shared-pair byte bounds. Checked addition prevents integer overflow.

```
 239         let reason = if columns[0] == "120000" {
 240             Some("symlink")
 241         } else if columns[1] == "commit" {
 242             Some("submodule")
 243         } else if path.ends_with(".d.ts")
 244             || path
 245                 .split('/')
 246                 .any(|part| ["node_modules", "dist", "build", "vendor"].contains(&part))
 247         {
 248             Some("generated-or-vendored")
 249         } else if ![".ts", ".tsx", ".mts", ".cts"]
 250             .iter()
 251             .any(|suffix| path.ends_with(suffix))
 252             && !(path.rsplit('/').next().is_some_and(|name| {
 253                 name == "package.json"
 254                     || name == "tsconfig.json"
 255                     || name.starts_with("tsconfig.") && name.ends_with(".json")
 256             }))
 257         {
 258             Some("unsupported-file")
 259         } else {
 260             None
 261         };
 262         if let Some(code) = reason {
 263             diagnostics.push(Diagnostic {
 264                 code,
 265                 stage: "snapshot",
 266                 message: "Tracked entry excluded from TypeScript analysis.",
 267                 path: path.to_owned(),
 268             });
 269             continue;
 270         }
 271         let bytes: usize = columns[3]
 272             .parse()
 273             .map_err(|_| Error::Invalid("invalid blob size"))?;
 274         if bytes > MAX_FILE {
 275             return Err(Error::Invalid("source file exceeds 1 MiB"));
 276         }
 277         *total = total
 278             .checked_add(bytes)
 279             .ok_or(Error::Invalid("snapshot size overflow"))?;
 280         if *total > MAX_BYTES {
 281             return Err(Error::Invalid("snapshot pair exceeds 32 MiB"));
 282         }
 283         entries.push((path.to_owned(), columns[2].to_owned(), bytes));
 284     }
```

### Lines 285-314

Deterministic path sorting fixes manifest order. All object IDs for one revision are written to a single cat-file --batch subprocess. Headers must match expected object/type/size before checked slices borrow blob bytes.

```
 285     entries.sort_by(|left, right| left.0.cmp(&right.0));
 286     let input = entries
 287         .iter()
 288         .map(|(_, oid, _)| format!("{oid}\n"))
 289         .collect::<String>()
 290         .into_bytes();
 291     let output = git(
 292         request,
 293         &["cat-file", "--batch"],
 294         input,
 295         MAX_BYTES + MAX_FILES * 128,
 296     )?;
 297     let mut remaining = output.as_slice();
 298     let mut files = Vec::new();
 299     for (path, oid, expected) in entries {
 300         let newline = remaining
 301             .iter()
 302             .position(|byte| *byte == b'\n')
 303             .ok_or(Error::Invalid("truncated blob header"))?;
 304         let header = std::str::from_utf8(&remaining[..newline])
 305             .map_err(|_| Error::Invalid("invalid blob header"))?;
 306         if header != format!("{oid} blob {expected}") {
 307             return Err(Error::Invalid("unexpected blob identity or size"));
 308         }
 309         remaining = &remaining[newline + 1..];
 310         if remaining.len() <= expected || remaining[expected] != b'\n' {
 311             return Err(Error::Invalid("truncated blob"));
 312         }
 313         let content = &remaining[..expected];
 314         remaining = &remaining[expected + 1..];
```

### Lines 315-351

Binary/invalid-UTF-8/LFS content is excluded visibly. SHA-256 yields a safe storage filename. Existing files must be regular, non-symlink and byte-identical; otherwise create_new prevents overwriting anything unexpected.

```
 315         if content.contains(&0)
 316             || content.starts_with(b"version https://git-lfs.github.com/spec/v1")
 317             || std::str::from_utf8(content).is_err()
 318         {
 319             diagnostics.push(Diagnostic {
 320                 code: "unsupported-content",
 321                 stage: "snapshot",
 322                 message: "Binary, invalid UTF-8 or LFS pointer excluded.",
 323                 path,
 324             });
 325             continue;
 326         }
 327         let digest = format!("{:x}", Sha256::digest(content));
 328         let storage = format!("{digest}.txt");
 329         let destination = Path::new(&request.output).join(&storage);
 330         if destination.try_exists()? {
 331             let metadata = fs::symlink_metadata(&destination)?;
 332             if metadata.file_type().is_symlink()
 333                 || !metadata.is_file()
 334                 || fs::read(&destination)? != content
 335             {
 336                 return Err(Error::Invalid("snapshot storage collision or symlink"));
 337             }
 338         } else {
 339             let mut file = OpenOptions::new()
 340                 .write(true)
 341                 .create_new(true)
 342                 .open(destination)?;
 343             file.write_all(content)?;
 344         }
 345         files.push(File {
 346             path,
 347             digest,
 348             bytes: expected,
 349             storage,
 350         });
 351     }
```

### Lines 352-357

Trailing batch output is a protocol error. Returning files transfers owned metadata; borrowed content slices end with the output Vec. No syntax/rule decision occurs in Rust.

```
 352     if !remaining.is_empty() {
 353         return Err(Error::Invalid("unexpected trailing blob data"));
 354     }
 355     Ok(files)
 356 }
 357
```

### Lines 358-434

run borrows Request and validates operation/version/policy, empty absolute output directory and repo bounds. It resolves both commits; PR mode requires a unique merge base, exact mode selects the base tip. Shared mutable accounting spans both snapshot reads.

```
 358 fn run(request: &Request) -> Result<Manifest, Error> {
 359     if request.protocol_version != 1
 360         || request.operation != "snapshot"
 361         || !["pr", "exact"].contains(&request.policy.as_str())
 362         || request.id.len() != 36
 363     {
 364         return Err(Error::Invalid(
 365             "unsupported request version, operation, policy or id",
 366         ));
 367     }
 368     let output = Path::new(&request.output);
 369     let metadata = fs::symlink_metadata(output)?;
 370     if !output.is_absolute()
 371         || metadata.file_type().is_symlink()
 372         || !metadata.is_dir()
 373         || fs::read_dir(output)?.next().is_some()
 374     {
 375         return Err(Error::Invalid(
 376             "output must be an empty absolute tool-created directory",
 377         ));
 378     }
 379     if request.repo.len() > 4000
 380         || request.output.len() > 4000
 381         || !Path::new(&request.repo).is_absolute()
 382     {
 383         return Err(Error::Invalid(
 384             "repository must be an absolute path of bounded length",
 385         ));
 386     }
 387     let git_path = fs::canonicalize(&request.git)?;
 388     if request.git.len() > 4000
 389         || !Path::new(&request.git).is_absolute()
 390         || !git_path.is_file()
 391         || git_path.starts_with(fs::canonicalize(&request.repo)?)
 392     {
 393         return Err(Error::Invalid(
 394             "Git executable must be an absolute trusted path outside the target repository",
 395         ));
 396     }
 397     let base = resolve_commit(request, &request.base)?;
 398     let head = resolve_commit(request, &request.head)?;
 399     let comparison_base = if request.policy == "pr" {
 400         let bytes = git(
 401             request,
 402             &["merge-base", "--all", &base, &head],
 403             vec![],
 404             1024,
 405         )?;
 406         let value = String::from_utf8(bytes).map_err(|_| Error::Invalid("invalid merge base"))?;
 407         if value.lines().count() != 1 {
 408             return Err(Error::Invalid("multiple merge bases are ambiguous"));
 409         }
 410         resolve_commit(request, value.trim())?
 411     } else {
 412         base.clone()
 413     };
 414     let mut total = 0;
 415     let mut diagnostics = Vec::new();
 416     let before = snapshot(request, &comparison_base, &mut total, &mut diagnostics)?;
 417     let after = snapshot(request, &head, &mut total, &mut diagnostics)?;
 418     Ok(Manifest {
 419         schema_version: 1,
 420         comparison: Comparison {
 421             requested_base: request.base.clone(),
 422             requested_head: request.head.clone(),
 423             resolved_base: base,
 424             resolved_head: head,
 425             comparison_base,
 426             policy: request.policy.clone(),
 427         },
 428         before,
 429         after,
 430         diagnostics,
 431         total_bytes: total,
 432     })
 433 }
 434
```

### Lines 435-477

main handles a bounded complete request or --version, retains the ID, and serializes exactly one result/error with completion signaling. Error exit is 2. Root ownership stays in TS; Rust never executes target code or modifies its working tree.

```
 435 fn main() {
 436     if std::env::args().nth(1).as_deref() == Some("--version") {
 437         println!("lens-snapshot 0.1.0 protocol=1");
 438         return;
 439     }
 440     let mut bytes = Vec::new();
 441     let read = io::stdin().lock().take(8193).read_to_end(&mut bytes);
 442     let request = if read.is_ok()
 443         && bytes.len() <= 8192
 444         && bytes.ends_with(b"\n")
 445         && !bytes[..bytes.len() - 1].contains(&b'\n')
 446     {
 447         serde_json::from_slice::<Request>(&bytes)
 448     } else {
 449         serde_json::from_slice::<Request>(b"null")
 450     };
 451     let (id, result) = match request {
 452         Ok(request) => (request.id.clone(), run(&request)),
 453         Err(_) => (
 454             String::new(),
 455             Err(Error::Invalid(
 456                 "invalid, truncated or oversized request frame",
 457             )),
 458         ),
 459     };
 460     let failed = result.is_err();
 461     let response = match result {
 462         Ok(manifest) => {
 463             serde_json::json!({ "protocolVersion": 1, "id": id, "type": "result", "manifest": manifest, "complete": true })
 464         }
 465         Err(error) => {
 466             serde_json::json!({ "protocolVersion": 1, "id": id, "type": "error", "code": "snapshot_failed", "stage": "snapshot", "message": error.to_string(), "retryable": false, "complete": true })
 467         }
 468     };
 469     if let Err(error) = serde_json::to_writer(io::stdout().lock(), &response).map(|_| println!()) {
 470         eprintln!("protocol output failed: {error}");
 471         std::process::exit(1);
 472     }
 473     if failed {
 474         std::process::exit(2);
 475     }
 476 }
 477
```

### Lines 478-501

Native tests cover unsafe path rejection, unusual-path acceptance and request shape failures. Real Git/protocol integration lives in Vitest so it crosses the shipped process boundary instead of only exercising Rust helpers.

```
 478 #[cfg(test)]
 479 mod tests {
 480     use super::*;
 481     #[test]
 482     fn path_boundary() {
 483         for path in [
 484             "../x.ts", "/x.ts", "C:/x.ts", "x\\y.ts", "a//b", "./x.ts", "a/../b",
 485         ] {
 486             assert!(!safe_path(path), "{path}");
 487         }
 488         for path in [
 489             "src/日本語.ts",
 490             "with space.ts",
 491             "-option.ts",
 492             "line\nbreak.ts",
 493         ] {
 494             assert!(safe_path(path), "{path}");
 495         }
 496     }
 497     #[test]
 498     fn rejects_wrong_request_shape() {
 499         assert!(serde_json::from_str::<Request>(r#"{"protocolVersion":1,"extra":true}"#).is_err());
 500     }
 501 }
```

## packages/lens-action/run.mjs

Source digest: 0d445d2ab6f2287d43c817d6631e23c141fbee630f0bab12b893366d53bdefd8. 46 lines. Explanation level: file-overview.

The trusted wrapper validates event repository, SHAs, trigger and outside-checkout tool/config roots; invokes the existing CLI with bounded subprocess output, then validates report refs/schema before writing summary/HTML/output-path files. Local simulation rejects privileged trigger and untrusted tool/config. It never installs target dependencies or publishes comments.

The complete excerpt below preserves the implementation; finer statement annotations remain a recorded learning gap.

### Lines 1-46

Complete file excerpt for review alongside its responsibility above.

```
   1 import { execFile } from "node:child_process";
   2 import { appendFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
   3 import { isAbsolute, join, relative, resolve } from "node:path";
   4 import { pathToFileURL } from "node:url";
   5 import { promisify } from "node:util";
   6
   7 const run = promisify(execFile);
   8 const inside = (root, candidate) => { const path = relative(root, candidate); return path === "" || (!path.startsWith("..") && !isAbsolute(path)); };
   9 const required = name => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
  10 const readBounded = async (path, limit) => { if ((await lstat(path)).size > limit) throw new Error("Artifact/input exceeds size limit"); return readFile(path, "utf8"); };
  11 try {
  12   if (required("GITHUB_EVENT_NAME") !== "pull_request") throw new Error("Only read-only pull_request analysis is supported");
  13   const event = JSON.parse(await readBounded(required("GITHUB_EVENT_PATH"), 1024 * 1024));
  14   if (event.repository?.full_name !== required("GITHUB_REPOSITORY")) throw new Error("Event repository does not match workflow repository");
  15   const base = event.pull_request?.base?.sha;
  16   const head = event.pull_request?.head?.sha;
  17   if (![base, head].every(value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value))) throw new Error("Event must contain exact base/head commit SHAs");
  18   const workspace = await realpath(required("GITHUB_WORKSPACE"));
  19   const tool = await realpath(required("LENS_TOOL_PACKAGE"));
  20   if (inside(workspace, tool)) throw new Error("Analyzer must be installed outside the untrusted checkout");
  21   const temporary = await realpath(required("RUNNER_TEMP"));
  22   if (inside(workspace, temporary)) throw new Error("Report directory must be outside the target checkout");
  23   const output = join(temporary, "lens-review");
  24   await mkdir(output, { recursive: true });
  25   const config = process.env.LENS_TRUSTED_CONFIG ? await realpath(process.env.LENS_TRUSTED_CONFIG) : undefined;
  26   if (config && inside(workspace, config)) throw new Error("CI configuration must come from outside the untrusted checkout");
  27   const env = { ...process.env };
  28   delete env.LENS_WORKER;
  29   const args = [join(tool, "dist/cli.js"), "review", "--repo", workspace, "--base", base, "--head", head, "--policy", "pr", "--format", "json", "--output", join(output, "report.json")];
  30   if (config) args.push("--config", config);
  31   try { await run(process.execPath, args, { env, timeout: 100000, maxBuffer: 65536, windowsHide: true }); }
  32   catch (error) { if (error.code !== 3) throw new Error("Trusted Lens engine failed; no successful analysis is claimed"); }
  33   const { reportSchema } = await import(pathToFileURL(join(tool, "dist/contracts.js")).href);
  34   const { render } = await import(pathToFileURL(join(tool, "dist/render.js")).href);
  35   const report = reportSchema.parse(JSON.parse(await readBounded(join(output, "report.json"), 64 * 1024 * 1024)));
  36   if (report.run.comparison.resolvedBase !== base || report.run.comparison.resolvedHead !== head || report.run.comparison.policy !== "pr") throw new Error("Report revisions do not match event metadata");
  37   const { writeFile } = await import("node:fs/promises");
  38   await writeFile(join(output, "report.html"), render(report, "html"));
  39   await appendFile(required("GITHUB_STEP_SUMMARY"), render(report, "markdown"));
  40   const safeOutput = resolve(output).replaceAll("\\", "/");
  41   if (/[\r\n]/.test(safeOutput)) throw new Error("Unsafe workflow output path");
  42   await appendFile(required("GITHUB_OUTPUT"), `report-directory=${safeOutput}\n`);
  43 } catch (error) {
  44   console.error(`Lens Action: ${String(error.message).replace(/[\x00-\x1f\x7f]/g, " ")}`);
  45   process.exitCode = 2;
  46 }
```

## packages/lens/src/analysis-worker.ts

Source digest: 75392b0c1d2b5863bfa54a7dc4c76f8f77ff76acaf0a471b69f6d666dff14ce1. 11 lines. Explanation level: statement-groups.

### Lines 1-6

The trusted worker imports the same engine, artifact logic and pinned-library loader. The parent supplies AnalysisInput as structured data; no target module is imported.

```
   1 import { parentPort, workerData } from "node:worker_threads";
   2 import { compareFiles } from "./compare.js";
   3 import { attachTestArtifact } from "./artifacts.js";
   4 import { loadTrustedLibraries } from "./libraries.js";
   5 import type { AnalysisInput } from "./analysis.js";
   6
```

### Lines 7-11

The worker performs project extraction/comparison, optional artifact metadata checks, enforces a serialized report-size bound and posts one completed report. The parent independently validates it and enforces deadline/cancellation.

```
   7 const input = workerData as AnalysisInput;
   8 let report = compareFiles(input.before, input.after, input.manifest, input.config, await loadTrustedLibraries());
   9 if (input.artifact !== undefined) report = attachTestArtifact(report, input.artifact, input.after);
  10 if (Buffer.byteLength(JSON.stringify(report)) > 64 * 1024 * 1024) throw new Error("Analysis report exceeds 64 MiB");
  11 parentPort!.postMessage(report);
```

## packages/lens/src/analysis.ts

Source digest: a7002665dfa8de1d7099434d7535854c91b7ac9d2a6635e057a4c6e5aa0190e8. 53 lines. Explanation level: statement-groups.

### Lines 1-12

The orchestrator owns one semantic worker and a typed snapshot/config/artifact input. Worker communication uses structured cloning; report validation still happens at the receiving boundary.

```
   1 import { Worker } from "node:worker_threads";
   2 import { reportSchema, type Manifest, type Report } from "./contracts.js";
   3 import type { InputFile } from "./extract.js";
   4
   5 export interface AnalysisInput {
   6   before: InputFile[];
   7   after: InputFile[];
   8   manifest: Manifest;
   9   config: unknown;
  10   artifact?: string;
  11 }
  12
```

### Lines 13-23

Already-canceled work and excessive snapshot/artifact input fail before a worker is created. The compiled trusted module receives captured strings only, with explicit V8 heap/stack limits, no inherited preload arguments, and cleared NODE_OPTIONS.

```
  13 export async function runAnalysis(input: AnalysisInput, signal?: AbortSignal, timeoutMs = 60000): Promise<Report> {
  14   signal?.throwIfAborted();
  15   if (input.artifact !== undefined && Buffer.byteLength(input.artifact) > 65536) throw new Error("Test artifact exceeds 64 KiB");
  16   if (input.before.length > 4000 || input.after.length > 4000 || [...input.before, ...input.after].reduce((bytes, file) => bytes + Buffer.byteLength(file.content), 0) > 33554432) throw new Error("Analysis input exceeds snapshot limits");
  17   return new Promise((resolve, reject) => {
  18     const worker = new Worker(new URL("./analysis-worker.js", import.meta.url), {
  19       workerData: input,
  20       execArgv: [],
  21       env: { ...process.env, NODE_OPTIONS: "" },
  22       resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 },
  23     });
```

### Lines 24-35

State distinguishes a received report from a settled Promise. Cleanup removes timers/listeners. Failure first marks settled, terminates the worker, then rejects after termination; merely rejecting a Promise would leave compiler work running.

```
  24     let result: Report | undefined;
  25     let settled = false;
  26     const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
  27     const fail = (error: Error): void => {
  28       if (settled) return;
  29       settled = true;
  30       cleanup();
  31       void worker.terminate().then(() => reject(error), () => reject(error));
  32     };
  33     const cancel = (): void => fail(new Error("Analysis canceled; semantic worker terminated"));
  34     const timer = setTimeout(() => fail(new Error(`Analysis exceeded ${timeoutMs}ms deadline; semantic worker terminated`)), timeoutMs);
  35     signal?.addEventListener("abort", cancel, { once: true });
```

### Lines 36-53

Exactly one validated report is accepted. Worker errors, nonzero/missing-result exits, deadlines and abort signals converge on owned cleanup. A clean exit resolves the previously validated result, so a partial unfinished worker never masquerades as analysis success.

```
  36     worker.on("message", (message: unknown) => {
  37       if (settled) return;
  38       try {
  39         if (result) throw new Error("Unexpected duplicate analysis result");
  40         result = reportSchema.parse(message);
  41       } catch (error) { fail(error instanceof Error ? error : new Error("Invalid analysis result")); }
  42     });
  43     worker.once("error", error => fail(new Error(`Analysis worker failed: ${error.message}`)));
  44     worker.once("exit", code => {
  45       if (settled) return;
  46       if (code !== 0 || !result) { fail(new Error(`Analysis worker exited ${code} without a complete report`)); return; }
  47       settled = true;
  48       cleanup();
  49       resolve(result);
  50     });
  51     if (signal?.aborted) cancel();
  52   });
  53 }
```

## packages/lens/src/artifacts.ts

Source digest: 0a44ee7f9377e6891b2bac0b2581da72594f063be5312b9be02f3de1245be844. 47 lines. Explanation level: statement-groups.

### Lines 1-12

Artifact processing is pure value/text comparison. The strict schema has exact version/kind, commit identities, config digest and a bounded file-digest map. It does not accept executable configuration or artifact claims of authenticated origin.

```
   1 import { z } from "zod";
   2 import { digest, reportSchema, type Evidence, type Report } from "./contracts.js";
   3 import type { InputFile } from "./extract.js";
   4
   5 const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
   6 export const testArtifactSchema = z.object({
   7   schemaVersion: z.literal(1), kind: z.literal("test-provenance"),
   8   comparisonBase: sha, head: sha, configDigest: z.string().regex(/^[a-f0-9]{64}$/),
   9   files: z.record(z.string().min(1).max(1000), z.string().regex(/^[a-f0-9]{64}$/))
  10     .refine(value => Object.keys(value).length <= 4000, "too many file digests"),
  11 }).strict();
  12
```

### Lines 13-21

The expected metadata is derived from actual run commits/config and captured-head contents, sorted by normalized paths. This produces a reproducible context for an external producer without running any target test.

```
  13 export function expectedArtifact(report: Report, files: InputFile[]): z.infer<typeof testArtifactSchema> {
  14   return {
  15     schemaVersion: 1, kind: "test-provenance",
  16     comparisonBase: report.run.comparison.comparisonBase,
  17     head: report.run.comparison.resolvedHead, configDigest: report.run.configDigest,
  18     files: Object.fromEntries([...files].sort((a, b) => a.path.localeCompare(b.path, "en")).map(file => [file.path, digest(file.content)])),
  19   };
  20 }
  21
```

### Lines 22-31

The 64 KiB bound precedes JSON parsing. Supplied and actual fields are compared; a cloned report preserves the caller's original value. Consistent claims remain unverified/partial and excluded from trusted associations.

```
  22 export function attachTestArtifact(report: Report, content: string, files: InputFile[]): Report {
  23   if (Buffer.byteLength(content) > 65536) throw new Error("Test provenance artifact exceeds 64 KiB");
  24   const supplied = testArtifactSchema.parse(JSON.parse(content));
  25   const expected = expectedArtifact(report, files);
  26   const mismatches: string[] = (["comparisonBase", "head", "configDigest"] as const)
  27     .filter(key => supplied[key] !== expected[key]);
  28   if (JSON.stringify(Object.entries(supplied.files).sort()) !== JSON.stringify(Object.entries(expected.files).sort())) mismatches.push("files");
  29   const result = structuredClone(report);
  30   result.run.completeness = "partial";
  31   result.run.diagnostics.push({ code: mismatches.length ? "artifact-mismatch" : "artifact-unverified", stage: "artifact", message: mismatches.length ? `Supplied test metadata mismatch: ${mismatches.join(", ")}; excluded from trusted associations.` : "Metadata is consistent, but producer/workflow origin is unauthenticated. Artifact is excluded from trusted associations." });
```

### Lines 32-42

A mismatch captures exact original artifact text and derived expected context with distinct evidence methods and logical metadata paths. SHA identities bind the difference. EVIDENCE001 states what disagrees while preserving the separate unauthenticated-origin limitation.

```
  32   if (mismatches.length) {
  33     const reference = (text: string, method: "supplied-artifact" | "derived-run-context"): Evidence => {
  34       const lines = text.split(/\r\n|\n/);
  35       return { revision: method, path: `${method}/test-provenance.json`, startLine: 1, startColumn: 1, endLine: lines.length, endColumn: lines.at(-1)!.length + 1, excerpt: text.slice(0, 12000), method, fileDigest: digest(text) };
  36     };
  37     const before = reference(content, "supplied-artifact");
  38     const after = reference(JSON.stringify(expected, null, 2), "derived-run-context");
  39     const identity = digest(`${before.fileDigest}\0${after.fileDigest}`).slice(0, 24);
  40     result.findings.push({ id: `finding:${identity}`, symbol: "artifact:test-provenance", ruleId: "EVIDENCE001", priority: "medium", strength: "structural", reason: `Supplied test-artifact metadata differs from this run: ${mismatches.join(", ")}.`, before, after, relatedTests: [], limitations: ["Matching metadata would not authenticate a producer/workflow or establish per-test attribution. No coverage/test-artifact association is trusted."], next: "Regenerate the artifact against the recorded commits/configuration and authenticate its origin separately before relying on it." });
  41     result.changes.push({ id: `change:${identity}`, symbol: "artifact:test-provenance", kind: "artifact-provenance-mismatch", before, after, ambiguity: "Metadata comparison does not authenticate artifact origin." });
  42   }
```

### Lines 43-47

Sorted findings/changes/diagnostics preserve determinism, and reportSchema validates the final public value. Malformed artifacts fail rather than becoming a successful report with zero findings.

```
  43   result.findings.sort((a, b) => a.id.localeCompare(b.id, "en"));
  44   result.changes.sort((a, b) => a.id.localeCompare(b.id, "en"));
  45   result.run.diagnostics.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
  46   return reportSchema.parse(result);
  47 }
```

## packages/lens/src/cli.ts

Source digest: 8b0d7df8d969d02d2a4be5915dc8cae147a44df8e25ea84b9583d5432bea504e. 87 lines. Explanation level: file-overview.

Commander parses validated enums/options; doctor checks exact runtime/worker metadata, review loads explicit trusted JSON, captures commits, compares pure values and atomically writes one renderer's result. Signals cancel owned work; errors are display-escaped. CLI and package/Action smoke tests are callers and verification. Removing explicit config trust or exit distinctions would hide partial results or let PR settings change policy.

The complete excerpt below preserves the implementation; finer statement annotations remain a recorded learning gap.

### Lines 1-87

Complete file excerpt for review alongside its responsibility above.

```
   1 #!/usr/bin/env node
   2 import { execFile } from "node:child_process";
   3 import { randomUUID } from "node:crypto";
   4 import { rename, rm, writeFile } from "node:fs/promises";
   5 import { resolve } from "node:path";
   6 import { promisify } from "node:util";
   7 import { Command, CommanderError, InvalidArgumentError } from "commander";
   8 import { configSchema, rules, version } from "./contracts.js";
   9 import { display, render } from "./render.js";
  10 import { capture, verifyPackagedWorker, workerPath } from "./snapshot.js";
  11 import { runAnalysis } from "./analysis.js";
  12 import { readBoundedText } from "./io.js";
  13 import { resolveTrustedGit } from "./trusted-git.js";
  14
  15 const program = new Command().name("lens").description("Evidence-backed static TypeScript revision review").version(version).exitOverride();
  16 program.configureOutput({ outputError: (message, write) => write(`${display(message.trimEnd())}\n`) });
  17 const choose = <T extends string>(options: readonly T[]) => (value: string): T => {
  18   if (!options.includes(value as T)) throw new InvalidArgumentError(`Choose ${options.join(", ")}`);
  19   return value as T;
  20 };
  21 program.command("rules").description("List implemented rules and their limits").action(() => {
  22   for (const [id, title] of Object.entries(rules)) console.log(`${id} ${title}`);
  23   console.log("Guard names: text-only heuristic. CALL001 requires resolved local targets. EVIDENCE001 checks metadata, never authenticates artifact origin.");
  24 });
  25 program.command("doctor").description("Check Node, Git and the trusted worker without changing the system").action(async () => {
  26   const check = async (binary: string, args: string[]): Promise<string> => {
  27     try { return (await promisify(execFile)(binary, args, { timeout: 5000, maxBuffer: 65536, windowsHide: true })).stdout.trim(); }
  28     catch { return "unavailable (build/install a compatible trusted worker; see package README)"; }
  29   };
  30   let integrity = true;
  31   try { await verifyPackagedWorker(); } catch { integrity = false; }
  32   const worker = integrity ? await check(workerPath(), ["--version"]) : "packaged worker integrity failed";
  33   let git = "unavailable: install Git in a trusted directory outside source checkouts";
  34   try { git = await check(await resolveTrustedGit(process.cwd()), ["--version"]); } catch { /* diagnostic below */ }
  35   const compiler = (await import("typescript")).default.version;
  36   const ready = /^v24\./.test(process.version) && compiler === "5.8.3" && worker === "lens-snapshot 0.1.0 protocol=1" && git.startsWith("git version ");
  37   console.log(JSON.stringify({ node: process.version, supportedNode: "24.x", compiler, platform: `${process.platform}-${process.arch}`, git, worker: display(worker), ready }, null, 2));
  38   if (!ready) process.exitCode = 2;
  39 });
  40 program.command("review").description("Compare immutable Git commits; never fetch or execute target code")
  41   .requiredOption("--base <ref>", "requested base commit/ref")
  42   .option("--head <ref>", "requested head commit/ref", "HEAD")
  43   .option("--repo <path>", "repository directory", ".")
  44   .option("--policy <policy>", "pr uses merge-base; exact uses base tip", choose(["pr", "exact"] as const), "pr")
  45   .option("--format <format>", "report format", choose(["terminal", "json", "html", "markdown"] as const), "terminal")
  46   .option("--output <path>", "atomic output file (parent must exist)")
  47   .option("--config <path>", "explicit trusted local JSON config, never loaded from the PR")
  48   .option("--test-artifact <path>", "bounded supplied test-provenance JSON (never trusted solely by its claims)")
  49   .option("--quiet", "suppress terminal report when no output is requested")
  50   .option("--verbose", "print stage time and counts to stderr")
  51   .option("--fail-on-findings", "opt-in policy exit 4")
  52   .action(async (options: { base: string; head: string; repo: string; policy: "pr" | "exact"; format: "terminal" | "json" | "html" | "markdown"; output?: string; config?: string; testArtifact?: string; quiet?: boolean; verbose?: boolean; failOnFindings?: boolean }) => {
  53     const controller = new AbortController();
  54     const cancel = (): void => controller.abort();
  55     process.once("SIGINT", cancel);
  56     process.once("SIGTERM", cancel);
  57     const started = performance.now();
  58     try {
  59       let config: unknown = {};
  60       if (options.config) {
  61         config = JSON.parse(await readBoundedText(options.config, 65536));
  62       }
  63       const validated = configSchema.parse(config);
  64       const snapshot = await capture(options.repo, options.base, options.head, options.policy, controller.signal);
  65       let artifact: string | undefined;
  66       if (options.testArtifact) {
  67         artifact = await readBoundedText(options.testArtifact, 65536);
  68       }
  69       const report = await runAnalysis({ before: snapshot.before, after: snapshot.after, manifest: snapshot.manifest, config: validated, ...(artifact === undefined ? {} : { artifact }) }, controller.signal);
  70       controller.signal.throwIfAborted();
  71       const content = render(report, options.format);
  72       if (Buffer.byteLength(content) > 64 * 1024 * 1024) throw new Error("Rendered report exceeds 64 MiB; reduce comparison scope");
  73       if (options.output) {
  74         const destination = resolve(options.output);
  75         const temporary = `${destination}.lens-${randomUUID()}`;
  76         try { await writeFile(temporary, content, { flag: "wx", mode: 0o600 }); await rename(temporary, destination); }
  77         finally { await rm(temporary, { force: true }); }
  78       } else if (!options.quiet) process.stdout.write(content);
  79       if (options.verbose) console.error(`Lens: ${Math.round(performance.now() - started)}ms; ${report.run.files} files; ${report.run.bytes} bytes; ${report.run.completeness}`);
  80       process.exitCode = options.failOnFindings && report.findings.length ? 4 : report.run.completeness === "partial" ? 3 : 0;
  81     } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  82   });
  83 try { await program.parseAsync(); }
  84 catch (error) {
  85   if (error instanceof CommanderError) process.exitCode = error.exitCode === 0 ? 0 : 2;
  86   else { console.error(`Lens: ${display(error instanceof Error ? error.message : String(error))}`); process.exitCode = 2; }
  87 }
```

## packages/lens/src/compare.ts

Source digest: 54bae992f3e94253a4babf5dc04b6643b111dc5ecbbcb4e68da122dc9598b280. 118 lines. Explanation level: statement-groups.

### Lines 1-15

Comparison depends on values and path normalization only. The limitations array states exactly what observations cannot establish; it becomes public report data rather than hidden README-only knowledge.

```
   1 import { posix } from "node:path";
   2 import { configSchema, digest, reportSchema, version, type Config, type Evidence, type Finding, type Manifest, type Report } from "./contracts.js";
   3 import { extract, type Facts, type InputFile, type TestFact } from "./extract.js";
   4 import { createProject, type LibraryFile } from "./project.js";
   5
   6 export const limitations = [
   7   "Static observations direct human review; zero findings does not mean safe.",
   8   "Types and return annotations are compared textually, not for semantic equivalence.",
   9   "Guard names use a text-only heuristic; equivalent enforcement elsewhere is unknown.",
  10   "Only exported named non-generic function declarations and simple exported interfaces are supported.",
  11   "Tests require named imports from vitest or @jest/globals, literal titles, and supported block callbacks.",
  12   "Test relationships use imported identifier references, not execution or assertion adequacy.",
  13   "CALL001 compares supported resolved local direct-call target sets, not behavior or a complete call graph. Test artifacts are not accepted yet.",
  14 ];
  15
```

### Lines 16-20

Relative imported module text is normalized against the test directory and matched only against captured paths. This narrow static resolver supports ordinary TS/JS-style relative imports, not re-export graphs or tsconfig aliases.

```
  16 function targetPath(testPath: string, specifier: string, paths: Set<string>): string | undefined {
  17   const stem = posix.normalize(posix.join(posix.dirname(testPath), specifier));
  18   return [stem, stem.replace(/\.js$/, ".ts"), `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`].find(path => paths.has(path));
  19 }
  20
```

### Lines 21-32

Runtime config is parsed first. Before/after captured strings become independent fact sets. Run metadata records versions, config digest, comparison and diagnostics without timestamps so repeated payloads remain deterministic.

```
  21 export function compareFiles(beforeFiles: InputFile[], afterFiles: InputFile[], manifest: Manifest, inputConfig: unknown = {}, libraries: LibraryFile[] = []): Report {
  22   const config: Config = configSchema.parse(inputConfig);
  23   const beforeProject = createProject(beforeFiles, libraries);
  24   const afterProject = createProject(afterFiles, libraries);
  25   const before = beforeFiles.filter(file => /\.[cm]?tsx?$/.test(file.path)).map(file => extract(file, config.guards, beforeProject, config.repositoryUrl));
  26   const after = afterFiles.filter(file => /\.[cm]?tsx?$/.test(file.path)).map(file => extract(file, config.guards, afterProject, config.repositoryUrl));
  27   const diagnostics = [...manifest.diagnostics, ...beforeProject.diagnostics, ...afterProject.diagnostics, ...before.flatMap(file => file.diagnostics), ...after.flatMap(file => file.diagnostics)];
  28   const report: Report = {
  29     schemaVersion: 1,
  30     run: { toolVersion: version, compilerVersion: "5.8.3", configDigest: digest(JSON.stringify(config)), comparison: manifest.comparison, completeness: "partial", diagnostics, unresolvedCalls: [...before, ...after].flatMap(file => file.functions).reduce((sum, fn) => sum + fn.unresolvedCalls, 0), files: beforeFiles.length + afterFiles.length, bytes: manifest.totalBytes },
  31     symbols: [], changes: [], findings: [], limitations,
  32   };
```

### Lines 33-44

File pairs prefer exact paths. For a missing path, only a unique identical-content candidate proves a narrow rename. Unmatched additions/deletions/moves stay partial. There is no speculative structural identity score.

```
  33   const pairs: Array<{ before: Facts; after: Facts; method: "exact-path-and-name" | "identical-blob-rename" }> = [];
  34   for (const old of before) {
  35     const exact = after.find(file => file.path === old.path);
  36     if (exact) { pairs.push({ before: old, after: exact, method: "exact-path-and-name" }); continue; }
  37     // A unique identical content digest is a verified narrow rename; edited renames stay unmatched.
  38     const hash = digest(beforeFiles.find(file => file.path === old.path)!.content);
  39     const candidates = afterFiles.filter(file => !beforeFiles.some(previous => previous.path === file.path) && digest(file.content) === hash);
  40     if (candidates.length === 1 && beforeFiles.filter(file => digest(file.content) === hash).length === 1) {
  41       pairs.push({ before: old, after: after.find(file => file.path === candidates[0]!.path)!, method: "identical-blob-rename" });
  42     } else diagnostics.push({ code: "unmatched-file", stage: "matching", path: old.path, message: "Deleted, moved or edited-renamed file: cross-file symbol matching is unknown." });
  43   }
  44   for (const file of after) if (!pairs.some(pair => pair.after === file)) diagnostics.push({ code: "unmatched-file", stage: "matching", path: file.path, message: "Added or unmatched file: no before/after symbol comparison available." });
```

### Lines 45-51

Unique scoped test titles pair within matched files. Missing or duplicate candidates emit uncertainty instead of manufacturing a removal finding. The test relationship can exist even when a test's assertions change.

```
  45   const testPairs: Array<{ before: TestFact; after: TestFact }> = [];
  46   for (const pair of pairs) for (const test of pair.before.tests) {
  47     const oldMatches = pair.before.tests.filter(candidate => candidate.name === test.name);
  48     const matches = pair.after.tests.filter(candidate => candidate.name === test.name);
  49     if (oldMatches.length === 1 && matches.length === 1) testPairs.push({ before: test, after: matches[0]! });
  50     else diagnostics.push({ code: "unmatched-test", stage: "matching", path: pair.before.path, message: `Test ${test.name} was removed, renamed or ambiguous; assertion comparison skipped.` });
  51   }
```

### Lines 52-56

Stable identity hashes include rule, scope, source ranges and digests. A Change and Finding are distinct records. Guard strength is heuristic, review priority is separate, and every finding includes limitations and a next inspection step.

```
  52   const emit = (ruleId: Finding["ruleId"], symbol: string, before: Evidence, after: Evidence, reason: string, strength: Finding["strength"] = "structural"): void => {
  53     const identity = digest(JSON.stringify([ruleId, symbol, before.path, before.startLine, after.path, after.startLine, before.fileDigest, after.fileDigest])).slice(0, 24);
  54     report.changes.push({ id: `change:${identity}`, kind: ruleId, symbol, before, after, ambiguity: strength === "heuristic" ? "Text identity does not establish resolved call identity." : null });
  55     report.findings.push({ id: `finding:${identity}`, symbol, ruleId, priority: ruleId === "GUARD001" ? "high" : "medium", strength, reason, before, after, relatedTests: [], limitations: ruleId === "GUARD001" ? [limitations[2]!] : ["A rewrite may preserve behavior; inspect the surrounding implementation."], next: "Inspect both revisions and related tests before deciding whether this change is intended." });
  56   };
```

### Lines 57-78

Unique matched exported functions compare parameter objects and explicit return text. Annotation presence changes become context diagnostics. Configured guard-set disappearance creates an observation, not a claim that authorization broke.

```
  57   for (const pair of pairs) {
  58     for (const old of pair.before.functions) {
  59       const matches = pair.after.functions.filter(candidate => candidate.name === old.name);
  60       if (matches.length !== 1) { diagnostics.push({ code: "unmatched-function", stage: "matching", path: pair.before.path, message: `Function ${old.name} has no supported unique match.` }); continue; }
  61       const current = matches[0]!;
  62       const id = `${pair.before.path}#${old.name}`;
  63       report.symbols.push({ id, name: old.name, kind: "function", source: current.source, matching: pair.method });
  64       if (JSON.stringify(old.parameters) !== JSON.stringify(current.parameters)) emit("API001", id, old.source, current.source, "Exported parameter structure changed (textual annotations, names, optional/default/rest structure).");
  65       if (old.returns !== null && current.returns !== null && old.returns !== current.returns) emit("API002", id, old.source, current.source, "Explicit return annotation changed; comparison method: textual annotation.");
  66       if ((old.returns === null) !== (current.returns === null)) diagnostics.push({ code: "return-context", stage: "comparison", path: pair.before.path, message: `Function ${old.name}: adding/removing a return annotation is outside API002.` });
  67       for (const guard of old.guards) if (!current.guards.has(guard)) emit("GUARD001", id, old.guardEvidence.get(guard)!, current.source, `Configured guard call ${guard} is absent from the matched function (text-only heuristic).`, "heuristic");
  68       if (!old.unresolvedCalls && !current.unresolvedCalls) {
  69         const normalizeTarget = (target: string): string => {
  70           const separator = target.lastIndexOf("#");
  71           const path = target.slice(0, separator);
  72           return `${pairs.find(candidate => candidate.before.path === path)?.after.path ?? path}${target.slice(separator)}`;
  73         };
  74         const oldTargets = [...old.resolvedCalls].map(normalizeTarget).sort();
  75         const newTargets = [...current.resolvedCalls].sort();
  76         if (JSON.stringify(oldTargets) !== JSON.stringify(newTargets)) emit("CALL001", id, old.source, current.source, `Resolved local direct-call target set changed: ${JSON.stringify(oldTargets)} -> ${JSON.stringify(newTargets)}. Method: snapshot TypeChecker declaration resolution; this does not prove behavioral change.`);
  77       }
  78     }
```

### Lines 79-89

A supported matched interface field only fires TYPE001 when it was required and becomes optional. Missing or already-optional properties do not satisfy that rule.

```
  79     for (const old of pair.before.interfaces) {
  80       const current = pair.after.interfaces.find(candidate => candidate.name === old.name);
  81       if (!current) continue;
  82       const id = `${pair.before.path}#${old.name}`;
  83       report.symbols.push({ id, name: old.name, kind: "interface", source: current.source, matching: pair.method });
  84       for (const [name, field] of old.fields) {
  85         const next = current.fields.get(name);
  86         if (!field.optional && next?.optional) emit("TYPE001", `${id}.${name}`, field.source, next.source, `Required field ${name} became optional.`);
  87       }
  88     }
  89   }
```

### Lines 90-101

Matched active tests becoming skip/todo fire TEST002. Ordered assertion excerpt sequences detect additions/removals/edits with explicit textual limits. Reordering is observable but does not prove behavioral change.

```
  90   for (const pair of testPairs) {
  91     const id = `${pair.before.source.path}#test:${pair.before.name}`;
  92     report.symbols.push({ id, name: pair.before.name, kind: "test", source: pair.after.source, matching: "exact-path-and-name" });
  93     if (pair.before.state === "active" && pair.after.state !== "active") emit("TEST002", id, pair.before.source, pair.after.source, `Test became ${pair.after.state}.`);
  94     // Preserve positional ambiguity explicitly: compare the ordered assertion sequence, not semantics.
  95     const oldText = pair.before.assertions.map(item => item.excerpt);
  96     const newText = pair.after.assertions.map(item => item.excerpt);
  97     if (JSON.stringify(oldText) !== JSON.stringify(newText)) {
  98       const kind = oldText.length > newText.length ? "removed" : oldText.length < newText.length ? "added" : "edited";
  99       emit("TEST001", id, pair.before.assertions[0] ?? pair.before.source, pair.after.assertions[0] ?? pair.after.source, `Supported assertion sequence ${kind}; ordered textual comparison does not prove changed behavior.`);
 100     }
 101   }
```

### Lines 102-113

A changed function gains a related test through a resolved imported declaration or captured relative named-import binding reference. Related test finding IDs join the protection observation to exact before/after test evidence. Path aliases can resolve through the captured Project; this is static linkage, not execution attribution.

```
 102   const paths = new Set(before.map(file => file.path));
 103   for (const finding of report.findings.filter(item => ["GUARD001", "API001", "API002", "CALL001"].includes(item.ruleId))) {
 104     const name = finding.symbol;
 105     for (const pair of testPairs) {
 106       const referenced = pair.before.resolvedReferences.has(name) || [...pair.before.references].some(reference => {
 107         const separator = reference.lastIndexOf("#");
 108         const target = targetPath(pair.before.source.path, reference.slice(0, separator), paths);
 109         return `${target}#${reference.slice(separator + 1)}` === name;
 110       });
 111       if (referenced) finding.relatedTests.push({ name: pair.before.name, method: "static-import-reference", before: pair.before.source, after: pair.after.source, changes: report.findings.filter(item => item.ruleId.startsWith("TEST") && item.before.path === pair.before.source.path && item.before.startLine >= pair.before.source.startLine && item.before.endLine <= pair.before.source.endLine).map(item => item.id) });
 112     }
 113   }
```

### Lines 114-118

Stable IDs and diagnostics are sorted. Any diagnostic makes completeness partial. Final reportSchema.parse checks the assembled public boundary; malformed evidence cannot silently reach a renderer.

```
 114   for (const key of ["symbols", "changes", "findings"] as const) report[key].sort((left, right) => left.id.localeCompare(right.id, "en"));
 115   diagnostics.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
 116   report.run.completeness = diagnostics.length ? "partial" : "complete-within-supported-syntax";
 117   return reportSchema.parse(report);
 118 }
```

## packages/lens/src/contracts.ts

Source digest: 4bdf472ad92656e6e5379518eda088d753a0ef514b3257fb97d27a6610c6d8c0. 39 lines. Explanation level: statement-groups.

### Lines 1-4

Node crypto computes content identity; Zod validates actual runtime values. Types alone vanish after compilation. Callers are extraction, comparison, CLI and the worker adapter; invalid boundary data throws before analysis.

```
   1 import { createHash } from "node:crypto";
   2 import { z } from "zod";
   3 import { repositoryUrlPattern, sourceUrlPattern } from "./links.js";
   4
```

### Lines 5-16

The version literal binds reports and packaged workers. SHA-256 returns a stable hex identity. The rule catalogue lists only implemented rules; its literal keys prevent inventing unsupported IDs in Finding values.

```
   5 export const version = "0.1.0";
   6 export const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
   7 export const rules = {
   8   API001: "Exported function parameter structure changed",
   9   API002: "Explicit return annotation changed (textual comparison)",
  10   TYPE001: "Exported interface field became optional",
  11   GUARD001: "Configured guard call absent from matched function",
  12   TEST001: "Assertion added, removed or edited in matched test",
  13   TEST002: "Matched test became skipped or todo",
  14   CALL001: "Supported resolved local direct-call target set changed",
  15   EVIDENCE001: "Supplied test-artifact metadata does not match this run",
  16 } as const;
```

### Lines 17-18

Strict config accepts only version and bounded guard text names, with an empty default. parse supplies runtime defaults; the inferred Config type follows the validator instead of duplicating its shape.

```
  17 export const configSchema = z.object({ schemaVersion: z.literal(1).default(1), guards: z.array(z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/)).max(50).default([]), repositoryUrl: z.string().regex(repositoryUrlPattern).optional() }).strict();
  18 export type Config = z.infer<typeof configSchema>;
```

### Lines 19-20

Commit IDs accept supported Git SHA lengths. Repository path refinement rejects absolute, parent, empty and backslash components. These conditions add filesystem semantics beyond generated structural JSON Schema.

```
  19 const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
  20 const path = z.string().min(1).max(1000).refine(value => !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && !value.split("/").some(part => part === ".." || part === "." || part === "") && !/^[A-Za-z]:/.test(value), "unsafe repository path");
```

### Lines 21-22

Evidence retains exact revision, normalized path, one-based coordinates, bounded excerpt, AST method and digest. If these fields were optional, a finding could claim evidence that cannot be located or checked.

```
  21 export const evidenceSchema = z.object({ revision: z.string().min(1), path, startLine: z.number().int().positive(), startColumn: z.number().int().positive(), endLine: z.number().int().positive(), endColumn: z.number().int().positive(), excerpt: z.string().max(12000), method: z.enum(["typescript-ast", "supplied-artifact", "derived-run-context"]), fileDigest: z.string().regex(/^[a-f0-9]{64}$/), url: z.string().regex(sourceUrlPattern).optional() }).strict();
  22 export type Evidence = z.infer<typeof evidenceSchema>;
```

### Lines 23-25

Symbol and Change remain separate from Finding. Matching method describes how identity was carried across versions; ambiguity is explicit. Finding stores review priority separately from structural/heuristic strength and records related-test method and limitations.

```
  23 export const symbolSchema = z.object({ id: z.string(), name: z.string(), kind: z.enum(["function", "interface", "test"]), source: evidenceSchema, matching: z.enum(["exact-path-and-name", "identical-blob-rename"]) }).strict();
  24 export const changeSchema = z.object({ id: z.string(), kind: z.string(), symbol: z.string(), before: evidenceSchema, after: evidenceSchema, ambiguity: z.string().nullable() }).strict();
  25 export const findingSchema = z.object({ id: z.string(), symbol: z.string(), ruleId: z.enum(["API001", "API002", "TYPE001", "GUARD001", "TEST001", "TEST002", "CALL001", "EVIDENCE001"]), priority: z.enum(["high", "medium", "low"]), strength: z.enum(["structural", "heuristic"]), reason: z.string(), before: evidenceSchema, after: evidenceSchema, relatedTests: z.array(z.object({ name: z.string(), method: z.literal("static-import-reference"), before: evidenceSchema, after: evidenceSchema, changes: z.array(z.string()) }).strict()), limitations: z.array(z.string()), next: z.string() }).strict();
```

### Lines 26-31

The run contract records requested refs, resolved commits and actual comparison base. Diagnostics describe partial stages. reportSchema rejects another schema/tool/compiler version instead of guessing compatibility.

```
  26 export const comparisonSchema = z.object({ requestedBase: z.string().min(1).max(1000), requestedHead: z.string().min(1).max(1000), resolvedBase: sha, resolvedHead: sha, comparisonBase: sha, policy: z.enum(["pr", "exact"]) }).strict();
  27 export const diagnosticSchema = z.object({ code: z.string(), stage: z.string(), message: z.string(), path: z.string().optional() }).strict();
  28 export const reportSchema = z.object({ schemaVersion: z.literal(1), run: z.object({ toolVersion: z.literal(version), compilerVersion: z.literal("5.8.3"), configDigest: z.string(), comparison: comparisonSchema, completeness: z.enum(["complete-within-supported-syntax", "partial"]), diagnostics: z.array(diagnosticSchema), unresolvedCalls: z.number().int().nonnegative(), files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }).strict(), symbols: z.array(symbolSchema), changes: z.array(changeSchema), findings: z.array(findingSchema), limitations: z.array(z.string()) }).strict();
  29 export type Report = z.infer<typeof reportSchema>;
  30 export type Finding = z.infer<typeof findingSchema>;
  31 export type Diagnostic = z.infer<typeof diagnosticSchema>;
```

### Lines 32-39

Manifest files are bounded and digest-named. The worker request has a literal version/operation and bounded parameters. The result/error discriminated union requires completion signaling and a nonretryable structured failure. snapshot.ts tests this cross-language boundary.

```
  32 export const fileSchema = z.object({ path, digest: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().min(0).max(1048576), storage: z.string().regex(/^[a-f0-9]{64}\.txt$/) }).strict();
  33 export const manifestSchema = z.object({ schemaVersion: z.literal(1), comparison: comparisonSchema, before: z.array(fileSchema).max(4000), after: z.array(fileSchema).max(4000), diagnostics: z.array(diagnosticSchema), totalBytes: z.number().int().min(0).max(33554432) }).strict();
  34 export type Manifest = z.infer<typeof manifestSchema>;
  35 export const requestSchema = z.object({ protocolVersion: z.literal(1), id: z.string().regex(/^[a-f0-9-]{36}$/), operation: z.literal("snapshot"), repo: z.string().min(1).max(4000), git: z.string().min(1).max(4000), output: z.string().min(1).max(4000), base: z.string().min(1).max(1000), head: z.string().min(1).max(1000), policy: z.enum(["pr", "exact"]) }).strict();
  36 export const responseSchema = z.discriminatedUnion("type", [
  37   z.object({ protocolVersion: z.literal(1), id: z.string(), type: z.literal("result"), manifest: manifestSchema, complete: z.literal(true) }).strict(),
  38   z.object({ protocolVersion: z.literal(1), id: z.string(), type: z.literal("error"), code: z.string(), stage: z.string(), message: z.string(), retryable: z.literal(false), complete: z.literal(true) }).strict(),
  39 ]);
```

## packages/lens/src/extract.ts

Source digest: 05d1dabadc94f7f01da8a0d5a17e9b6ed456a8192b0bd7eda9b0d09a32b6b98b. 163 lines. Explanation level: statement-groups.

### Lines 1-12

The adapter depends only on the pinned compiler and contracts; no filesystem or target module is imported. Fact interfaces model syntax, tests and evidence as ordinary values for pure comparison.

```
   1 import ts from "typescript";
   2 import { digest, type Diagnostic, type Evidence } from "./contracts.js";
   3 import type { Project } from "./project.js";
   4 import { sourceUrl } from "./links.js";
   5
   6 export interface InputFile { path: string; content: string; revision: string; }
   7 export interface Parameter { name: string; type: string | null; optional: boolean; rest: boolean; initializer: string | null; }
   8 export interface FunctionFact { name: string; parameters: Parameter[]; returns: string | null; guards: Set<string>; guardEvidence: Map<string, Evidence>; resolvedCalls: Set<string>; unresolvedCalls: number; source: Evidence; }
   9 export interface InterfaceFact { name: string; fields: Map<string, { optional: boolean; source: Evidence }>; source: Evidence; }
  10 export interface TestFact { name: string; state: "active" | "skip" | "todo"; assertions: Evidence[]; references: Set<string>; resolvedReferences: Set<string>; source: Evidence; }
  11 export interface Facts { path: string; functions: FunctionFact[]; interfaces: InterfaceFact[]; tests: TestFact[]; diagnostics: Diagnostic[]; }
  12
```

### Lines 13-23

SourceFile parses the supplied captured string, with TSX selected explicitly. The evidence closure converts compiler UTF-16 offsets to one-based line/column coordinates and hashes the original string. It caps display excerpts while retaining full ranges.

```
  13 export function extract(file: InputFile, guards: readonly string[], project?: Project, repositoryUrl?: string): Facts {
  14   const source = project?.sources.get(file.path) ?? ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  15   const facts: Facts = { path: file.path, functions: [], interfaces: [], tests: [], diagnostics: [] };
  16   const evidence = (node: ts.Node): Evidence => {
  17     const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  18     const end = source.getLineAndCharacterOfPosition(node.getEnd());
  19     const url = sourceUrl(repositoryUrl, file.revision, file.path, start.line + 1, end.line + 1, end.character + 1);
  20     return { revision: file.revision, path: file.path, startLine: start.line + 1, startColumn: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1, excerpt: node.getText(source).slice(0, 12000), method: "typescript-ast", fileDigest: digest(file.content), ...(url ? { url } : {}) };
  21   };
  22   const diagnose = (code: string, message: string): void => { facts.diagnostics.push({ code, message, path: file.path, stage: "extraction" }); };
  23   // Parse errors are observable through a Program without relying on private SourceFile fields.
```

### Lines 24-41

The fixture fallback CompilerHost exposes only this captured SourceFile. The real review path instead supplies its captured multi-file Project. Both hosts reject emitting output and cannot fall back to today's checkout. Program supplies diagnostics and a binder; that isolation fixes the original provenance defect.

```
  24   const host: ts.CompilerHost = {
  25     getSourceFile: name => name === file.path ? source : undefined,
  26     fileExists: name => name === file.path,
  27     readFile: name => name === file.path ? file.content : undefined,
  28     getDefaultLibFileName: () => "__no_lib__.d.ts",
  29     writeFile: () => { throw new Error("Analysis cannot emit target code"); },
  30     getCurrentDirectory: () => "",
  31     getDirectories: () => [],
  32     directoryExists: () => false,
  33     getCanonicalFileName: name => name,
  34     useCaseSensitiveFileNames: () => true,
  35     getNewLine: () => "\n",
  36   };
  37   const program = project?.program ?? ts.createProgram([file.path], { noLib: true, noResolve: true }, host);
  38   if (program.getSyntacticDiagnostics(source).length) {
  39     diagnose("parse-error", "File has TypeScript syntax errors; no facts extracted.");
  40     return facts;
  41   }
```

### Lines 42-55

The binder supplies symbol identity. Named imports map local aliases to module/export names and symbols. This allows a later reference to persist to be distinguished from a shadowed local persist without claiming full project resolution.

```
  42   const checker = program.getTypeChecker();
  43   const imported = new Map<string, { module: string; exported: string; symbol: ts.Symbol | undefined; resolved?: string }>();
  44   for (const statement of source.statements) {
  45     if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
  46       const bindings = statement.importClause?.namedBindings;
  47       if (bindings && ts.isNamedImports(bindings)) for (const specifier of bindings.elements) {
  48         const symbol = checker.getSymbolAtLocation(specifier.name);
  49         const target = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  50         const declaration = target?.declarations?.find(ts.isFunctionDeclaration);
  51         const path = declaration && project?.pathOf(declaration.getSourceFile());
  52         imported.set(specifier.name.text, { module: statement.moduleSpecifier.text, exported: specifier.propertyName?.text ?? specifier.name.text, symbol, ...(path && declaration?.name ? { resolved: `${path}#${declaration.name.text}` } : {}) });
  53       }
  54     }
  55   }
```

### Lines 56-58

Modifier checks narrow the initial exported-function contract. Recursive walking visits syntax children. The function list is top-level, avoiding accidental pairing of unrelated nested declarations.

```
  56   const exports = (node: ts.Node): boolean => ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
  57   const walk = (node: ts.Node, visit: (node: ts.Node) => void): void => { visit(node); ts.forEachChild(node, child => walk(child, visit)); };
  58   const functions = source.statements.filter(ts.isFunctionDeclaration);
```

### Lines 59-97

Unsupported overload/generic/destructured/generator declarations emit diagnostics. Guard traversal skips nested functions so an uncalled helper is not counted as outer protection. Stored parameter/default/rest/annotation values are later compared textually.

```
  59   for (const node of functions) {
  60     if (!exports(node) || !node.name) continue;
  61     if (!node.body || node.asteriskToken || node.typeParameters?.length || functions.filter(candidate => candidate.name?.text === node.name?.text).length !== 1 || node.parameters.some(parameter => !ts.isIdentifier(parameter.name))) {
  62       diagnose("unsupported-function", `Function ${node.name.text}: overloads, generics, declarations or destructured parameters are unsupported.`);
  63       continue;
  64     }
  65     const calls = new Set<string>();
  66     const guardEvidence = new Map<string, Evidence>();
  67     const resolvedCalls = new Set<string>();
  68     let unresolvedCalls = 0;
  69     const callName = (expression: ts.Expression): string | undefined => {
  70       if (ts.isIdentifier(expression)) return expression.text;
  71       if (ts.isPropertyAccessExpression(expression)) {
  72         const receiver = callName(expression.expression);
  73         return receiver === undefined ? undefined : `${receiver}.${expression.name.text}`;
  74       }
  75       return undefined;
  76     };
  77     const visitBody = (child: ts.Node): void => {
  78       if (child !== node && ts.isFunctionLike(child)) return;
  79       if (ts.isCallExpression(child)) {
  80         const name = callName(child.expression);
  81         if (name !== undefined && guards.includes(name)) { calls.add(name); guardEvidence.set(name, evidence(child)); }
  82         if (project) {
  83           const declaration = checker.getResolvedSignature(child)?.declaration;
  84           const targetPath = declaration && project.pathOf(declaration.getSourceFile());
  85           if (declaration && !targetPath && declaration.getSourceFile().fileName.startsWith("/__lens_typescript_lib__/")) {
  86             // Trusted built-in library calls are outside the local target-set contract.
  87           } else if (declaration && ts.isFunctionDeclaration(declaration) && declaration.name && declaration.body && ts.isSourceFile(declaration.parent) && targetPath && declaration.parent.statements.filter(candidate => ts.isFunctionDeclaration(candidate) && candidate.name?.text === declaration.name?.text).length === 1) {
  88             resolvedCalls.add(`${targetPath}#${declaration.name.text}`);
  89           } else unresolvedCalls++;
  90         }
  91       }
  92       ts.forEachChild(child, visitBody);
  93     };
  94     visitBody(node);
  95     if (unresolvedCalls) diagnose("unresolved-calls", `${node.name.text}: ${unresolvedCalls} call(s) lack a supported resolved target; CALL001 is excluded for this function.`);
  96     facts.functions.push({ name: node.name.text, parameters: node.parameters.map(parameter => ({ name: parameter.name.getText(source), type: parameter.type?.getText(source) ?? null, optional: !!parameter.questionToken || !!parameter.initializer, rest: !!parameter.dotDotDotToken, initializer: parameter.initializer?.getText(source) ?? null })), returns: node.type?.getText(source) ?? null, guards: calls, guardEvidence, resolvedCalls, unresolvedCalls, source: evidence(node) });
  97   }
```

### Lines 98-112

Simple exported interfaces store identifier-property optional flags and source evidence. Generic/inherited/merged forms remain unsupported. Other export forms generate diagnostics rather than pretending the initial API contract covers them.

```
  98   for (const node of source.statements) {
  99     if (ts.isInterfaceDeclaration(node) && exports(node)) {
 100       if (node.typeParameters?.length || node.heritageClauses?.length || source.statements.filter(candidate => ts.isInterfaceDeclaration(candidate) && candidate.name.text === node.name.text).length !== 1) {
 101         diagnose("unsupported-interface", `Interface ${node.name.text}: generic, inherited or merged declarations are unsupported.`);
 102         continue;
 103       }
 104       const fields = new Map<string, { optional: boolean; source: Evidence }>();
 105       for (const member of node.members) {
 106         if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) fields.set(member.name.text, { optional: !!member.questionToken, source: evidence(member) });
 107         else diagnose("unsupported-field", `Interface ${node.name.text} contains unsupported members.`);
 108       }
 109       facts.interfaces.push({ name: node.name.text, fields, source: evidence(node) });
 110     }
 111     if (exports(node) && (ts.isVariableStatement(node) || ts.isClassDeclaration(node) || ts.isExportDeclaration(node))) diagnose("unsupported-export", "Exported variables, classes, methods and re-exports are outside this syntax release.");
 112   }
```

### Lines 113-137

Only named imports from the declared framework modules are recognized. collectTests walks direct test expressions and nested describe blocks, builds scoped literal titles, and requires supported skip/todo/block-callback syntax.

```
 113   const isFramework = (name: string, family: readonly string[]): boolean => {
 114     const binding = imported.get(name);
 115     return !!binding && ["vitest", "@jest/globals"].includes(binding.module) && family.includes(binding.exported);
 116   };
 117   // Narrow contract: top-level imported test/it, or inside imported describe callbacks.
 118   const collectTests = (statements: ts.NodeArray<ts.Statement>, scope: string[]): void => {
 119     for (const statement of statements) {
 120       if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
 121       const call = statement.expression;
 122       let rootCall: ts.Expression = call.expression;
 123       while (ts.isPropertyAccessExpression(rootCall) || ts.isCallExpression(rootCall)) rootCall = rootCall.expression;
 124       const frameworkRoot = ts.isIdentifier(rootCall) && isFramework(rootCall.text, ["test", "it", "describe"]) && checker.getSymbolAtLocation(rootCall) === imported.get(rootCall.text)?.symbol;
 125       let callee = call.expression;
 126       let state: TestFact["state"] = "active";
 127       if (ts.isPropertyAccessExpression(callee) && ["skip", "todo"].includes(callee.name.text)) { state = callee.name.text as "skip" | "todo"; callee = callee.expression; }
 128       if (!ts.isIdentifier(callee)) { if (frameworkRoot) diagnose("unsupported-test", "Parameterized, conditional or wrapped test/suite calls are unsupported."); continue; }
 129       const title = call.arguments[0];
 130       const callback = call.arguments[1];
 131       if (!title || !ts.isStringLiteral(title)) { if (frameworkRoot) diagnose("unsupported-test", "Test and suite titles must be static string literals."); continue; }
 132       if (isFramework(callee.text, ["describe"]) && callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && ts.isBlock(callback.body)) {
 133         if (state !== "active" || !frameworkRoot) { diagnose("unsupported-test", "Modified or shadowed describe calls are unsupported."); continue; }
 134         collectTests(callback.body.statements, [...scope, title.text]);
 135       }
 136       if (!isFramework(callee.text, ["test", "it"]) || checker.getSymbolAtLocation(callee) !== imported.get(callee.text)?.symbol) continue;
 137       if (state !== "todo" && (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || !ts.isBlock(callback.body))) { diagnose("unsupported-test", "Test requires a literal title and block callback."); continue; }
```

### Lines 138-159

The callback walk records references only when the bound symbol is the import. Assertion chains must root at the imported expect and end in the supported matcher family. Each assertion retains its own evidence; unsupported matchers are visible diagnostics.

```
 138       const assertions: Evidence[] = [];
 139       const references = new Set<string>();
 140       const resolvedReferences = new Set<string>();
 141       if (callback) walk(callback, child => {
 142         if (ts.isIdentifier(child) && imported.has(child.text)) {
 143           const binding = imported.get(child.text)!;
 144           if (checker.getSymbolAtLocation(child) === binding.symbol) {
 145             if (binding.module.startsWith(".")) references.add(`${binding.module}#${binding.exported}`);
 146             if (binding.resolved) resolvedReferences.add(binding.resolved);
 147           }
 148         }
 149         if (!ts.isCallExpression(child)) return;
 150         let expression: ts.Expression = child.expression;
 151         while (ts.isPropertyAccessExpression(expression)) expression = expression.expression;
 152         if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && isFramework(expression.expression.text, ["expect"]) && checker.getSymbolAtLocation(expression.expression) === imported.get(expression.expression.text)?.symbol) {
 153           if (ts.isPropertyAccessExpression(child.expression) && ["toBe", "toEqual", "toThrow"].includes(child.expression.name.text)) assertions.push(evidence(child));
 154           else diagnose("unsupported-assertion", "Only expect(...)[.not/.rejects/.resolves].toBe/toEqual/toThrow assertions are supported.");
 155         }
 156       });
 157       facts.tests.push({ name: [...scope, title.text].join(" / "), state, assertions, references, resolvedReferences, source: evidence(call) });
 158     }
 159   };
```

### Lines 160-163

Duplicate scoped titles create ambiguity diagnostics. Returning Facts keeps extraction separate from rules and rendering. Fixture, alias, Unicode and boundary tests verify this adapter's contract.

```
 160   collectTests(source.statements, []);
 161   for (const test of facts.tests) if (facts.tests.filter(candidate => candidate.name === test.name).length > 1) diagnose("ambiguous-test", `Duplicate test title ${test.name}; matching will be skipped.`);
 162   return facts;
 163 }
```

## packages/lens/src/index.ts

Source digest: 7975367e15a6e07bb23e5248add3bdbf295d91fb3ad2c4e9f8956d6bdd9947bd. 6 lines. Explanation level: file-overview.

Named exports provide the stable pure fixture/library entry points and report types; no I/O or analysis occurs merely by importing this module.

The complete excerpt below preserves the implementation; finer statement annotations remain a recorded learning gap.

### Lines 1-6

Complete file excerpt for review alongside its responsibility above.

```
   1 export { compareFiles } from "./compare.js";
   2 export { extract } from "./extract.js";
   3 export { configSchema, reportSchema, rules, version } from "./contracts.js";
   4 export type { Report, Evidence, Finding } from "./contracts.js";
   5 export { expectedArtifact, attachTestArtifact, testArtifactSchema } from "./artifacts.js";
   6 export { runAnalysis } from "./analysis.js";
```

## packages/lens/src/io.ts

Source digest: f075797b1d185f625bb2122c4af2d978338ec8e76f3baaa2877f3c07b7d7579e. 24 lines. Explanation level: statement-groups.

### Lines 1-2

File handles provide bounded local I/O without invoking a shell or target code.

```
   1 import { open } from "node:fs/promises";
   2
```

### Lines 3-21

Opening before checking handle metadata avoids trusting only a previous path stat. Regular-file/type and size checks happen before chunk allocation. Reading at most limit+1 detects growth; only initialized byte slices are retained. finally closes the handle on every ordinary failure.

```
   3 export async function readBoundedFile(path: string, limit: number): Promise<Buffer> {
   4   const handle = await open(path, "r");
   5   try {
   6     const metadata = await handle.stat();
   7     if (!metadata.isFile() || metadata.size > limit) throw new Error(`Input must be a regular file of at most ${limit} bytes`);
   8     const chunks: Buffer[] = [];
   9     let total = 0;
  10     while (total <= limit) {
  11       const chunk = Buffer.allocUnsafe(Math.min(65536, limit + 1 - total));
  12       const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
  13       if (!bytesRead) break;
  14       chunks.push(chunk.subarray(0, bytesRead));
  15       total += bytesRead;
  16     }
  17     if (total > limit) throw new Error(`Input grew beyond ${limit} bytes during reading`);
  18     return Buffer.concat(chunks, total);
  19   } finally { await handle.close(); }
  20 }
  21
```

### Lines 22-24

Strict UTF-8 decoding rejects malformed input instead of silently replacing bytes. Config, artifact, compiler library and snapshot adapters choose distinct documented limits at their call sites.

```
  22 export async function readBoundedText(path: string, limit: number): Promise<string> {
  23   return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readBoundedFile(path, limit));
  24 }
```

## packages/lens/src/libraries.ts

Source digest: dc2c67f542b6e356ca019828a14d3a9fe0b2538c68b59e3a5331137ff29eaa4f. 21 lines. Explanation level: statement-groups.

### Lines 1-7

This I/O adapter loads the pinned tool-owned TypeScript declarations separately from pure project construction. It never points to target node_modules or target configuration.

```
   1 import ts from "typescript";
   2 import { readdir, lstat } from "node:fs/promises";
   3 import { dirname, join } from "node:path";
   4 import type { LibraryFile } from "./project.js";
   5 import { readBoundedText } from "./io.js";
   6
   7 // This reads the tool's pinned compiler installation, never target dependencies.
```

### Lines 8-21

The compiler's own library directory is the trust source. Names are restricted to lib*.d.ts, sorted, checked for regular non-symlink files and bounded by file/aggregate size. Bounded strict text reads create plain strings for the virtual host; no declaration is executed.

```
   8 export async function loadTrustedLibraries(): Promise<LibraryFile[]> {
   9   const root = dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2022 }));
  10   const files: LibraryFile[] = [];
  11   let bytes = 0;
  12   for (const name of (await readdir(root)).sort()) {
  13     if (!/^lib(?:\.[\w.]+)?\.d\.ts$/.test(name)) continue;
  14     const path = join(root, name);
  15     const stat = await lstat(path);
  16     bytes += stat.size;
  17     if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4 * 1024 * 1024 || bytes > 16 * 1024 * 1024) throw new Error("Trusted compiler library installation violates bounds");
  18     files.push({ path: name, content: await readBoundedText(path, 4 * 1024 * 1024) });
  19   }
  20   return files;
  21 }
```

## packages/lens/src/links.ts

Source digest: 3e0435a28782ff1bb5b2455c54254260244a8be2e24db04e55f7d723a4e1d78c. 9 lines. Explanation level: statement-groups.

### Lines 1-3

Only explicit HTTPS GitHub owner/repository roots are accepted. Generated source URLs must use an exact commit and a line anchor; userinfo, arbitrary hosts and executable schemes are rejected.

```
   1 export const repositoryUrlPattern = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/;
   2 export const sourceUrlPattern = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/blob\/(?:[a-f0-9]{40}|[a-f0-9]{64})\/[^\s<>"'()]+#L[1-9]\d*(?:-L[1-9]\d*)?$/;
   3
```

### Lines 4-9

Without a trusted origin or valid full SHA, no link is invented. Each path segment uses RFC3986-safe percent encoding, including parentheses/quotes that could escape Markdown. End-exclusive ranges ending at column 1 stop at the previous line. Evidence before/after already supplies base/head SHA respectively.

```
   4 export function sourceUrl(repository: string | undefined, revision: string, path: string, start: number, end: number, endColumn: number): string | undefined {
   5   if (!repository || !repositoryUrlPattern.test(repository) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) return undefined;
   6   const encoded = path.split("/").map(part => encodeURIComponent(part).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
   7   const finalLine = Math.max(start, endColumn === 1 && end > start ? end - 1 : end);
   8   return `${repository.replace(/\/$/, "")}/blob/${revision}/${encoded}#L${start}${finalLine > start ? `-L${finalLine}` : ""}`;
   9 }
```

## packages/lens/src/project.ts

Source digest: ee42451796960830a3c205fca1390c61b004a70d0f13fff63de658f7f0160cce. 90 lines. Explanation level: statement-groups.

### Lines 1-16

The pure project builder depends on compiler data and path normalization only. Project exposes Program, captured sources, diagnostics and a source-to-repository path mapping; library strings arrive explicitly from the caller.

```
   1 import ts from "typescript";
   2 import { posix } from "node:path";
   3 import type { Diagnostic } from "./contracts.js";
   4 import type { InputFile } from "./extract.js";
   5
   6 const root = "/__lens_snapshot__";
   7 export interface Project {
   8   program: ts.Program;
   9   sources: Map<string, ts.SourceFile>;
  10   diagnostics: Diagnostic[];
  11   pathOf(source: ts.SourceFile): string | undefined;
  12 }
  13 export interface LibraryFile { path: string; content: string; }
  14
  15 // Every compiler read is a map lookup. The caller supplies any trusted libraries.
  16 // No target configuration or source is imported/executed as JavaScript.
```

### Lines 17-25

An untested compiler version fails rather than being mislabeled 5.8.3. Captured source and trusted standard declarations occupy different virtual roots. All reads normalize to map keys, so no missing source can fall through to the working tree.

```
  17 export function createProject(files: InputFile[], libraries: LibraryFile[] = []): Project {
  18   if (ts.version !== "5.8.3") throw new Error(`Unsupported compiler ${ts.version}; this adapter requires TypeScript 5.8.3`);
  19   const contents = new Map(files.map(file => [`${root}/${file.path}`, file.content]));
  20   const libraryRoot = "/__lens_typescript_lib__";
  21   for (const file of libraries) contents.set(`${libraryRoot}/${file.path}`, file.content);
  22   const diagnostics: Diagnostic[] = [];
  23   const normalize = (path: string): string => posix.normalize(path.replaceAll("\\", "/"));
  24   const read = (path: string): string | undefined => contents.get(normalize(path));
  25   const inside = (path: string): boolean => normalize(path).startsWith(`${root}/`);
```

### Lines 26-35

Config parsing accepts only files inside the captured root. readDirectory enumerates captured TS context, not disk. Default NodeNext/ES2022 options give a documented initial resolution policy before a root captured config overrides supported options.

```
  26   const configHost: ts.ParseConfigHost = {
  27     useCaseSensitiveFileNames: true,
  28     readDirectory: directory => [...contents.keys()].filter(path => inside(path) && path.startsWith(`${normalize(directory)}/`) && /\.[cm]?tsx?$/.test(path)),
  29     fileExists: path => inside(path) && read(path) !== undefined,
  30     readFile: path => inside(path) ? read(path) : undefined,
  31   };
  32   let options: ts.CompilerOptions = {
  33     target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
  34     moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true,
  35   };
```

### Lines 36-48

Root tsconfig parsing follows captured relative extends and reports missing/outside configuration. References are diagnosed rather than built/merged; plugins are diagnosed and never loaded. Before and after use their respective config snapshots.

```
  36   const configPath = `${root}/tsconfig.json`;
  37   if (contents.has(configPath)) {
  38     const loaded = ts.readConfigFile(configPath, configHost.readFile);
  39     if (loaded.error) diagnostics.push({ code: "config-error", stage: "project", message: ts.flattenDiagnosticMessageText(loaded.error.messageText, " "), path: "tsconfig.json" });
  40     else {
  41       // readFile/fileExists refuse any extends outside the captured root.
  42       const parsed = ts.parseJsonConfigFileContent(loaded.config, configHost, root, undefined, configPath);
  43       options = { ...options, ...parsed.options };
  44       for (const error of parsed.errors) diagnostics.push({ code: "config-error", stage: "project", message: ts.flattenDiagnosticMessageText(error.messageText, " "), path: "tsconfig.json" });
  45       if (parsed.projectReferences?.length) diagnostics.push({ code: "project-references", stage: "project", message: "Project references are not built or merged; captured source is analyzed as one project.", path: "tsconfig.json" });
  46       if (Array.isArray(options.plugins) && options.plugins.length) diagnostics.push({ code: "config-plugins", stage: "project", message: "Compiler plugins are never loaded.", path: "tsconfig.json" });
  47     }
  48   }
```

### Lines 49-57

Analysis always disables emit, incremental state and plugins. Source enumeration comes from the snapshot contract, not tsconfig include/exclude. Virtual directory membership makes ordinary compiler module resolution work without filesystem traversal.

```
  49   // Source enumeration is the snapshot contract, not tsconfig include/exclude.
  50   options = { ...options, noEmit: true, noLib: libraries.length === 0,
  51     skipLibCheck: true, incremental: false, composite: false, plugins: [] };
  52   const cache = new Map<string, ts.SourceFile>();
  53   const directories = new Set<string>();
  54   for (const path of contents.keys()) {
  55     let directory = posix.dirname(path);
  56     while (directory !== "/") { directories.add(directory); directory = posix.dirname(directory); }
  57   }
```

### Lines 58-74

getSourceFile parses only strings present in the bounded map, caching source nodes within this Program. Default library selection follows compiler options inside the trusted virtual library root. writeFile always fails; canonical path, directory and realpath operations remain virtual.

```
  58   const host: ts.CompilerHost = {
  59     getSourceFile: (name, languageVersion) => {
  60       const path = normalize(name);
  61       const content = read(path);
  62       if (content === undefined) return undefined;
  63       if (!cache.has(path)) cache.set(path, ts.createSourceFile(path, content, languageVersion, true));
  64       return cache.get(path);
  65     },
  66     getDefaultLibFileName: () => `${libraryRoot}/${ts.getDefaultLibFileName(options)}`,
  67     writeFile: () => { throw new Error("Snapshot analysis cannot emit code"); },
  68     getCurrentDirectory: () => root,
  69     getDirectories: directory => [...directories].filter(path => posix.dirname(path) === normalize(directory)),
  70     directoryExists: directory => directories.has(normalize(directory)),
  71     fileExists: path => contents.has(normalize(path)), readFile: read,
  72     getCanonicalFileName: normalize, useCaseSensitiveFileNames: () => true,
  73     getNewLine: () => "\n", realpath: normalize,
  74   };
```

### Lines 75-90

Only captured TS-family source files are roots. Program resolves modules using this host, then captured sources are indexed back to normalized repository paths. Missing imports/re-exports and compiler options become completeness diagnostics rather than fabricated semantic context.

```
  75   const roots = files.filter(file => /\.[cm]?tsx?$/.test(file.path)).map(file => `${root}/${file.path}`);
  76   const program = ts.createProgram(roots, options, host);
  77   const sources = new Map<string, ts.SourceFile>();
  78   for (const source of program.getSourceFiles()) if (inside(source.fileName)) {
  79     const path = source.fileName.slice(root.length + 1);
  80     sources.set(path, source);
  81     for (const statement of source.statements) {
  82       if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
  83         const specifier = statement.moduleSpecifier.text;
  84         if (!ts.resolveModuleName(specifier, source.fileName, options, host).resolvedModule) diagnostics.push({ code: "missing-module", stage: "project", path, message: `Module ${specifier} is absent from captured/trusted context; no target dependencies are installed.` });
  85       }
  86     }
  87   }
  88   for (const diagnostic of program.getOptionsDiagnostics()) diagnostics.push({ code: "compiler-options", stage: "project", message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " ") });
  89   return { program, sources, diagnostics, pathOf: source => inside(source.fileName) ? source.fileName.slice(root.length + 1) : undefined };
  90 }
```

## packages/lens/src/render.ts

Source digest: 191fe3924617c2ec98c1aec14b451c83b5304c2948ee24eeb6ff5c5422044543. 126 lines. Explanation level: statement-groups.

Four value-only renderers share the report. JSON preserves raw data through JSON encoding; terminal/Markdown escape controls and syntax; HTML escapes source/metadata, supplies CSP, responsive pairs and native disclosure without scripts/assets. render.test.ts checks injection surfaces and round-trip behavior. No renderer reads files or recomputes findings.

Statement groups below explain the local implementation.

### Lines 1-3

Renderers consume already validated Report values and never read target files, start a process or rerun rules. Evidence is typed to retain exact source locations.

```
   1 import type { Evidence, Report } from "./contracts.js";
   2 import { sourceUrlPattern } from "./links.js";
   3
```

### Lines 4-8

Control and bidi characters become visible Unicode escapes before terminal/workflow display. This prevents source paths or reasons from rewriting lines or injecting screen-control sequences.

```
   4 export function display(value: string): string {
   5   return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
   6     character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
   7 }
   8
```

### Lines 9-14

HTML metacharacters become entities. This primitive does not decide whitespace policy: metadata first uses display, while source excerpts intentionally retain normal line breaks.

```
   9 function escapeHtml(value: string): string {
  10   return value.replace(/[&<>"']/g, character => ({
  11     "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  12   })[character]!);
  13 }
  14
```

### Lines 15-20

Metadata, revision/path location text and Markdown each use their own encoding context. Markdown metacharacters cannot create attacker-chosen links or raw HTML.

```
  15 const htmlText = (value: string): string => escapeHtml(display(value));
  16 const location = (evidence: Evidence): string =>
  17   `${evidence.method === "typescript-ast" ? "" : `[${evidence.method}] `}${evidence.revision.slice(0, 12)}:${evidence.path}:${evidence.startLine}:${evidence.startColumn}`;
  18 const markdownText = (value: string): string =>
  19   display(value).replace(/[\\`*_{}[\]()#+.!|<>~]/g, "\\$&");
  20
```

### Lines 21-40

The terminal renderer lists priority, evidence strength and both revision locations, then static test methods and a bounded diagnostic preview. It always retains the no-findings-does-not-mean-safe limitation.

```
  21 function terminal(report: Report, title: string): string {
  22   const lines = [title,
  23     `Completeness: ${report.run.completeness}; ${report.findings.length} finding(s); ${report.run.diagnostics.length} diagnostic(s)`];
  24   for (const finding of report.findings) {
  25     lines.push(`\n${finding.ruleId} [${finding.priority}; ${finding.strength}] ${display(finding.reason)}`,
  26       `  before ${display(location(finding.before))}`,
  27       `  after  ${display(location(finding.after))}`);
  28     if (finding.before.url && sourceUrlPattern.test(finding.before.url)) lines.push(`  before URL ${finding.before.url}`);
  29     if (finding.after.url && sourceUrlPattern.test(finding.after.url)) lines.push(`  after URL  ${finding.after.url}`);
  30     for (const test of finding.relatedTests) {
  31       lines.push(`  related test: ${display(test.name)} (${test.method}; ${test.changes.length} changed observations)`);
  32     }
  33   }
  34   for (const diagnostic of report.run.diagnostics.slice(0, 30)) {
  35     lines.push(`${display(diagnostic.code)}: ${display(diagnostic.path ?? "")} ${display(diagnostic.message)}`);
  36   }
  37   lines.push("\nNo findings does not mean safe. Inspect limitations in the JSON/HTML report.", "");
  38   return lines.join("\n");
  39 }
  40
```

### Lines 41-59

Workflow summaries use escaped text sections over the same findings. Exact before/after locations and relationship methods are preserved without repository-supplied executable markup or links.

```
  41 function markdown(report: Report, title: string): string {
  42   const sections = [`## ${title}`,
  43     `Completeness: ${report.run.completeness}. Findings: ${report.findings.length}.`];
  44   for (const finding of report.findings) {
  45     sections.push(`### ${finding.ruleId}: ${markdownText(finding.reason)}`,
  46       `Priority: ${finding.priority}; evidence: ${finding.strength}.`,
  47       `Before: ${markdownText(location(finding.before))}`,
  48       `After: ${markdownText(location(finding.after))}`);
  49     if (finding.before.url && sourceUrlPattern.test(finding.before.url)) sections.push(`[Source before](${finding.before.url})`);
  50     if (finding.after.url && sourceUrlPattern.test(finding.after.url)) sections.push(`[Source after](${finding.after.url})`);
  51     for (const test of finding.relatedTests) {
  52       sections.push(`Related test: ${markdownText(test.name)}; method: ${test.method}; changed observations: ${test.changes.length}.`);
  53     }
  54   }
  55   sections.push("No findings does not mean safe.",
  56     ...report.limitations.map(limitation => `- ${markdownText(limitation)}`), "");
  57   return sections.join("\n\n");
  58 }
  59
```

### Lines 60-70

Source code keeps newline structure for reading while other controls/bidi text become visible data. Escaping follows normalization, so a source closing tag cannot escape its code element.

```
  60 function excerpt(label: string, evidence: Evidence): string {
  61   // Keep source line breaks, but display other controls/bidi characters as data.
  62   const source = evidence.excerpt.replace(/\r\n/g, "\n")
  63     .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, display);
  64   const labelText = htmlText(location(evidence));
  65   const reference = evidence.url && sourceUrlPattern.test(evidence.url)
  66     ? `<a href="${escapeHtml(evidence.url)}" rel="noreferrer">${labelText}</a>` : labelText;
  67   return `<div><h3>${label}</h3><p>${reference}</p>
  68     <pre><code>${escapeHtml(source)}</code></pre></div>`;
  69 }
  70
```

### Lines 71-118

Each finding becomes an article with paired evidence and native keyboard-accessible test disclosure. The static template supplies responsive columns, visible focus, inline styles and restrictive CSP, with no scripts or network assets. Metadata and source enter only escaped placeholders.

```
  71 function html(report: Report, title: string): string {
  72   const articles = report.findings.map(finding => {
  73     const tests = finding.relatedTests.map(test => `<details>
  74       <summary>Related test: ${htmlText(test.name)}
  75         (${test.method}; ${test.changes.length} changed observations)</summary>
  76       <div class="pair">${excerpt("Test before", test.before)}${excerpt("Test after", test.after)}</div>
  77     </details>`).join("");
  78     return `<article>
  79       <h2>${finding.ruleId}: ${htmlText(finding.reason)}</h2>
  80       <p>Review priority: ${finding.priority}. Evidence strength: ${finding.strength}.</p>
  81       <div class="pair">${excerpt("Before", finding.before)}${excerpt("After", finding.after)}</div>
  82       ${tests}
  83       <p>${htmlText(finding.next)}</p>
  84       <ul>${finding.limitations.map(value => `<li>${htmlText(value)}</li>`).join("")}</ul>
  85     </article>`;
  86   }).join("");
  87   const diagnostics = report.run.diagnostics.map(diagnostic =>
  88     `<li>${htmlText(`${diagnostic.code}: ${diagnostic.path ?? ""} ${diagnostic.message}`)}</li>`).join("");
  89   return `<!doctype html>
  90 <html lang="en"><head>
  91 <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  92 <meta http-equiv="Content-Security-Policy"
  93   content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  94 <title>Lens review</title>
  95 <style>
  96   body { font:16px/1.55 system-ui,sans-serif; background:#f1f5f9; color:#172033;
  97     max-width:1100px; margin:auto; padding:24px; }
  98   article,section,header { background:white; border:1px solid #cbd5e1;
  99     padding:20px; margin-bottom:18px; border-radius:8px; }
 100   pre { white-space:pre-wrap; overflow-wrap:anywhere; background:#f8fafc;
 101     padding:14px; font:13px/1.6 monospace; }
 102   .pair { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
 103   .pair>div { min-width:0; }
 104   summary { cursor:pointer; font-weight:600; }
 105   summary:focus-visible { outline:3px solid #2563eb; }
 106   h1 { font-size:25px; } h2 { font-size:19px; }
 107   p,li { overflow-wrap:anywhere; }
 108   @media(max-width:700px) { .pair { grid-template-columns:1fr; } body { padding:12px; } }
 109 </style></head><body>
 110 <header><h1>${htmlText(title)}</h1>
 111   <p>Completeness: ${report.run.completeness}. ${report.findings.length} finding(s).
 112     No findings does not mean safe.</p></header>
 113 ${articles}
 114 <section><h2>Completeness diagnostics</h2><ul>${diagnostics}</ul>
 115   <h2>Limitations</h2><ul>${report.limitations.map(value => `<li>${htmlText(value)}</li>`).join("")}</ul>
 116 </section></body></html>\n`;
 117 }
 118
```

### Lines 119-126

The public renderer dispatches from one immutable report to JSON/terminal/Markdown/HTML. JSON.stringify preserves original data through JSON escaping; display encoders are never reused to corrupt the underlying report.

```
 119 export function render(report: Report, format: "json" | "terminal" | "html" | "markdown"): string {
 120   if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
 121   const comparison = report.run.comparison;
 122   const title = `Lens review: ${comparison.comparisonBase.slice(0, 12)} -> ${comparison.resolvedHead.slice(0, 12)} (${comparison.policy})`;
 123   if (format === "terminal") return terminal(report, title);
 124   if (format === "markdown") return markdown(report, title);
 125   return html(report, title);
 126 }
```

## packages/lens/src/schema.ts

Source digest: de29f6e867e2a2e489bbb8e000aa43b6a617d5fa519da5db8f1bd36f3ea249c9. 16 lines. Explanation level: file-overview.

Zod is converted into JSON Schema 2020-12; build writes stable artifacts and --check reads/compares them. This is a developer file-writing script, never an analyzer stage. Refinements still run in Zod. Drift failure prevents incompatible published schemas.

The complete excerpt below preserves the implementation; finer statement annotations remain a recorded learning gap.

### Lines 1-16

Complete file excerpt for review alongside its responsibility above.

```
   1 import { mkdir, readFile, writeFile } from "node:fs/promises";
   2 import { fileURLToPath } from "node:url";
   3 import { z } from "zod";
   4 import { configSchema, reportSchema, requestSchema, responseSchema } from "./contracts.js";
   5 import { testArtifactSchema } from "./artifacts.js";
   6
   7 const directory = new URL("../schemas/", import.meta.url);
   8 await mkdir(directory, { recursive: true });
   9 for (const [name, schema] of Object.entries({ report: reportSchema, request: requestSchema, response: responseSchema, config: configSchema, "test-artifact": testArtifactSchema })) {
  10   // Path refinements are additionally enforced by Zod; the published schema describes structure.
  11   const json = `${JSON.stringify(z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }), null, 2)}\n`;
  12   const destination = new URL(`${name}.schema.json`, directory);
  13   if (process.argv.includes("--check")) {
  14     if (await readFile(destination, "utf8") !== json) throw new Error(`Schema drift: ${fileURLToPath(destination)}`);
  15   } else await writeFile(destination, json);
  16 }
```

## packages/lens/src/snapshot.ts

Source digest: 496daabb1453026effb773777df7fea1aee88eb16f6db99ec354ff460f5e5df6. 123 lines. Explanation level: statement-groups.

### Lines 1-16

Node owns process and temporary-resource orchestration; Ajv and Zod validate the wire contract. The 16 MiB response and 64 KiB stderr limits are independent of the 8 KiB request bound.

```
   1 import { spawn, execFile } from "node:child_process";
   2 import { randomUUID } from "node:crypto";
   3 import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
   4 import { tmpdir } from "node:os";
   5 import { join, resolve } from "node:path";
   6 import { dirname } from "node:path";
   7 import { fileURLToPath } from "node:url";
   8 import { Ajv2020 } from "ajv/dist/2020.js";
   9 import { z } from "zod";
  10 import { digest, requestSchema, responseSchema, type Manifest } from "./contracts.js";
  11 import type { InputFile } from "./extract.js";
  12 import { readBoundedFile, readBoundedText } from "./io.js";
  13 import { resolveTrustedGit } from "./trusted-git.js";
  14
  15 const maxOutput = 16 * 1024 * 1024;
  16 const validator = new Ajv2020({ strict: false, allErrors: true }).compile(z.toJSONSchema(responseSchema));
```

### Lines 17-20

Default worker paths are package-local and platform-specific. LENS_WORKER is an explicit trusted developer override. No target checkout executable or floating download is selected automatically.

```
  17 export function workerPath(): string {
  18   return process.env.LENS_WORKER ?? fileURLToPath(new URL(`../bin/${process.platform}-${process.arch}/lens-snapshot${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
  19 }
  20
```

### Lines 21-27

Installed metadata pins binary version, protocol, platform and digest. File type/size/hash checks detect substitution or corruption. The trusted package archive supplies authenticity; the checksum itself does not prove publisher identity.

```
  21 export async function verifyPackagedWorker(binary = workerPath()): Promise<void> {
  22   if (process.env.LENS_WORKER || binary !== workerPath()) return;
  23   const metadata = z.object({ version: z.literal("0.1.0"), protocolVersion: z.literal(1), target: z.literal(`${process.platform}-${process.arch}`), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(JSON.parse(await readBoundedText(join(dirname(binary), "worker.json"), 65536)));
  24   const stat = await lstat(binary);
  25   if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 32 * 1024 * 1024 || digest(await readBoundedFile(binary, 32 * 1024 * 1024)) !== metadata.sha256) throw new Error("Packaged worker integrity/compatibility check failed");
  26 }
  27
```

### Lines 28-38

Cancellation targets the owned process group on Unix and attempts taskkill /T on Windows. A restricted-session fallback kills the direct child. Tests exercise timeout/cancellation; full descendant guarantees remain a documented platform limit.

```
  28 async function killTree(child: ReturnType<typeof spawn>): Promise<void> {
  29   if (!child.pid || child.exitCode !== null) return;
  30   if (process.platform === "win32") {
  31     await new Promise<void>(done => execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 1000 }, () => done()));
  32     // Restricted Windows sessions may reject taskkill; still terminate our direct child.
  33     if (child.exitCode === null) child.kill("SIGKILL");
  34   } else {
  35     try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  36   }
  37 }
  38
```

### Lines 39-47

The request is parsed/serialized/bounded before spawn. An already-aborted signal prevents launching work. The worker is launched directly with pipes and shell=false; protocol input is data, never shell text.

```
  39 export async function invokeWorker(request: unknown, binary = workerPath(), signal?: AbortSignal, timeout = 90000, binaryArgs: string[] = []): Promise<Manifest> {
  40   const validated = requestSchema.parse(request);
  41   const frame = Buffer.from(`${JSON.stringify(validated)}\n`);
  42   if (frame.length > 8192) throw new Error("Worker request exceeds 8192 bytes");
  43   signal?.throwIfAborted();
  44   await verifyPackagedWorker(binary);
  45   signal?.throwIfAborted();
  46   return new Promise((accept, reject) => {
  47     const child = spawn(binary, binaryArgs, { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, detached: process.platform !== "win32" });
```

### Lines 48-59

Chunks arrive independently of JSON framing. Accumulation, total counters and deadline track bounded untrusted output. The first failure is preserved while owned child cleanup proceeds.

```
  48     const chunks: Buffer[] = [];
  49     let bytes = 0;
  50     let diagnosticBytes = 0;
  51     let failure: Error | undefined;
  52     const fail = (error: Error): void => {
  53       if (failure) return;
  54       failure = error;
  55       void killTree(child);
  56     };
  57     const cancel = (): void => fail(new Error("Analysis canceled; worker process tree terminated"));
  58     const timer = setTimeout(() => fail(new Error("Snapshot worker exceeded timeout")), timeout);
  59     signal?.addEventListener("abort", cancel, { once: true });
```

### Lines 60-70

Both streams are consumed concurrently. Overflow terminates work; stderr is never forwarded raw. Abort listeners and timers are removed when the process ends, preventing stale callbacks after a run.

```
  60     child.stdout.on("data", (chunk: Buffer) => {
  61       bytes += chunk.length;
  62       if (bytes > maxOutput) fail(new Error("Worker stdout exceeds 16 MiB"));
  63       else chunks.push(chunk);
  64     });
  65     child.stderr.on("data", (chunk: Buffer) => {
  66       diagnosticBytes += chunk.length;
  67       if (diagnosticBytes > 65536) fail(new Error("Worker stderr exceeds 64 KiB"));
  68     });
  69     child.stdin.on("error", error => fail(error));
  70     child.once("error", error => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(new Error(`Cannot launch trusted snapshot worker: ${error.message}`)); });
```

### Lines 71-92

close occurs after stdio closes. The decoder rejects invalid UTF-8, missing newline and extra frames. Ajv/Zod, ID matching, exit status and requested-policy/ref checks must all succeed before the manifest resolves.

```
  71     child.once("close", code => {
  72       clearTimeout(timer);
  73       signal?.removeEventListener("abort", cancel);
  74       if (failure) { reject(failure); return; }
  75       try {
  76         const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  77         if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) throw new Error("Expected exactly one completed NDJSON worker response");
  78         const value: unknown = JSON.parse(text);
  79         if (!validator(value)) throw new Error("Worker response violates JSON Schema");
  80         const response = responseSchema.parse(value);
  81         if (response.id !== validated.id) throw new Error("Worker response request ID mismatch");
  82         if (response.type === "error") throw new Error(`${response.code} at ${response.stage}: ${response.message}`);
  83         if (code !== 0) throw new Error(`Worker exited ${code} after result`);
  84         const comparison = response.manifest.comparison;
  85         if (comparison.requestedBase !== validated.base || comparison.requestedHead !== validated.head || comparison.policy !== validated.policy || (validated.policy === "exact" && comparison.comparisonBase !== comparison.resolvedBase)) throw new Error("Worker comparison does not match requested policy/refs");
  86         accept(response.manifest);
  87       } catch (error) { reject(error); }
  88     });
  89     child.stdin.end(frame);
  90   });
  91 }
  92
```

### Lines 93-100

capture owns a scoped temporary directory and resolves the explicit repository root. The real worker receives that empty directory; the returned manifest never chooses a new root.

```
  93 export async function capture(repo: string, base: string, head: string, policy: "pr" | "exact", signal?: AbortSignal, binary?: string): Promise<{ manifest: Manifest; before: InputFile[]; after: InputFile[] }> {
  94   const directory = await mkdtemp(join(tmpdir(), "lens-snapshot-"));
  95   try {
  96     const repository = await realpath(resolve(repo));
  97     const manifest = await invokeWorker({ protocolVersion: 1, id: randomUUID(), operation: "snapshot", repo: repository, git: await resolveTrustedGit(repository), output: directory, base, head, policy }, binary, signal);
  98     const declaredBytes = [...manifest.before, ...manifest.after].reduce((sum, entry) => sum + entry.bytes, 0);
  99     if (declaredBytes > 33554432 || declaredBytes > manifest.totalBytes) throw new Error("Manifest aggregate byte accounting is inconsistent");
 100     const root = await realpath(directory);
```

### Lines 101-116

Each entry must have a unique normalized path, regular non-symlink storage file, expected bounded size, root-contained realpath and matching digest. Strict UTF-8 decoding creates InputFile values for the requested revision.

```
 101     const read = async (entries: Manifest["before"], revision: string): Promise<InputFile[]> => {
 102       const result: InputFile[] = [];
 103       const paths = new Set<string>();
 104       for (const entry of entries) {
 105         signal?.throwIfAborted();
 106         if (paths.has(entry.path)) throw new Error("Duplicate path in snapshot manifest");
 107         paths.add(entry.path);
 108         const path = join(directory, entry.storage);
 109         const metadata = await lstat(path);
 110         if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== entry.bytes || metadata.size > 1048576 || await realpath(path) !== join(root, entry.storage)) throw new Error("Snapshot file escaped root or violates size/type contract");
 111         const bytes = await readBoundedFile(path, 1048576);
 112         if (bytes.length !== entry.bytes || digest(bytes) !== entry.digest) throw new Error("Snapshot content digest/size mismatch");
 113         result.push({ path: entry.path, revision, content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) });
 114       }
 115       return result;
 116     };
```

### Lines 117-123

Base/head strings are fully captured before finally removes the directory. Cleanup runs for normal success and errors/cancellation. A hard host crash still needs future scavenging; it is not described as verified cleanup.

```
 117     const before = await read(manifest.before, manifest.comparison.comparisonBase);
 118     const after = await read(manifest.after, manifest.comparison.resolvedHead);
 119     return { manifest, before, after };
 120   } finally {
 121     await rm(directory, { recursive: true, force: true });
 122   }
 123 }
```

## packages/lens/src/trusted-git.ts

Source digest: 7af984a57ca7beaf29991a636898e44e75e04241d22c5ce4e4e9c328cc11a427. 35 lines. Explanation level: statement-groups.

### Lines 1-4

Executable discovery uses filesystem metadata and path operations without executing any candidate. This is separate from immutable object reading.

```
   1 import { access, lstat, realpath } from "node:fs/promises";
   2 import { constants } from "node:fs";
   3 import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
   4
```

### Lines 5-9

Path-relative containment checks distinguish a target child from a sibling with a similar prefix, including Windows drive boundaries.

```
   5 function within(root: string, path: string): boolean {
   6   const result = relative(root, path);
   7   return result === "" || !isAbsolute(result) && result !== ".." && !result.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
   8 }
   9
```

### Lines 10-20

Walking candidate ancestors detects source checkout .git files/directories. Unreadable candidates are rejected conservatively. No repository script is run to discover this fact.

```
  10 async function inCheckout(path: string): Promise<boolean> {
  11   let directory = dirname(path);
  12   while (true) {
  13     try { await lstat(join(directory, ".git")); return true; }
  14     catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true; }
  15     const parent = dirname(directory);
  16     if (parent === directory) return false;
  17     directory = parent;
  18   }
  19 }
  20
```

### Lines 21-35

Only absolute PATH entries are considered; target and source-checkout candidates are skipped. realpath resolves symlinks before checks, regular/executable metadata is required, and the actual absolute tool path is sent to Rust. This prevents current-directory or repo PATH git.exe from becoming target execution. Absence produces an actionable error, never a local fallback.

```
  21 export async function resolveTrustedGit(repo: string, pathValue = process.env.PATH ?? ""): Promise<string> {
  22   const root = await realpath(repo);
  23   for (const entry of pathValue.split(delimiter)) {
  24     const directory = entry.replace(/^"(.*)"$/, "$1");
  25     if (!isAbsolute(directory)) continue;
  26     try {
  27       const candidate = await realpath(join(directory, process.platform === "win32" ? "git.exe" : "git"));
  28       if (within(root, candidate) || await inCheckout(candidate)) continue;
  29       if (!(await lstat(candidate)).isFile()) continue;
  30       await access(candidate, constants.X_OK);
  31       return candidate;
  32     } catch { /* An unusable PATH entry is not a reason to execute a local fallback. */ }
  33   }
  34   throw new Error("No trusted Git executable outside source checkouts found on absolute PATH entries; install Git in a trusted tool directory");
  35 }
```

## packages/lens/test/action.test.ts

Source digest: 8b99abc6257a7a069604a4afb6615de4f8e55af530a3997657ab8da9ce8640c0. 27 lines. Explanation level: test-overview.

This behavior fixture supplies concrete inputs and checks only the stated contract. Read its test titles with the corresponding chapter: each expectation demonstrates a supported observation, rejected boundary or unchanged negative. Full individual statement annotations remain a recorded learning gap.

### Lines 1-27

Complete file excerpt for review alongside its responsibility above.

```
   1 import { execFile } from "node:child_process";
   2 import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
   3 import { tmpdir } from "node:os";
   4 import { join, resolve } from "node:path";
   5 import { promisify } from "node:util";
   6 import { describe, expect, it } from "vitest";
   7
   8 const run = promisify(execFile);
   9 describe("trusted Action launcher (local simulation only)", () => {
  10   it("uses exact event commits and refuses a tool/config from the target checkout", async () => {
  11     const root = await mkdtemp(join(tmpdir(), "lens-action-"));
  12     try {
  13       const fixture = JSON.parse(await readFile(resolve("../../output/evaluation.json"), "utf8"));
  14       const event = join(root, "event.json");
  15       await writeFile(event, JSON.stringify({ repository: { full_name: "fixture/test" }, pull_request: { head: { sha: fixture.commits.head }, base: { sha: fixture.commits.base }, number: 1 } }));
  16       const env = { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: "fixture/test", GITHUB_WORKSPACE: fixture.repository, RUNNER_TEMP: root, LENS_TOOL_PACKAGE: resolve("."), GITHUB_STEP_SUMMARY: join(root, "summary.md"), GITHUB_OUTPUT: join(root, "outputs.txt") };
  17       await run(process.execPath, [resolve("../lens-action/run.mjs")], { env, timeout: 10000 });
  18       const report = JSON.parse(await readFile(join(root, "lens-review/report.json"), "utf8"));
  19       expect(report.run.comparison.resolvedHead).toBe(fixture.commits.head);
  20       expect(report.findings.length).toBeGreaterThan(0);
  21       expect(await readFile(env.GITHUB_STEP_SUMMARY, "utf8")).toContain("Lens review");
  22       for (const change of [{ LENS_TOOL_PACKAGE: fixture.repository }, { LENS_TRUSTED_CONFIG: join(fixture.repository, "api.ts") }, { GITHUB_EVENT_NAME: "pull_request_target" }]) {
  23         await expect(run(process.execPath, [resolve("../lens-action/run.mjs")], { env: { ...env, ...change }, timeout: 10000 })).rejects.toThrow();
  24       }
  25     } finally { await rm(root, { recursive: true, force: true }); }
  26   });
  27 });
```

## packages/lens/test/analysis.test.ts

Source digest: 8251536ba57825d1fbba7464547d1e98b637555b7b5c633ca05eaffc43875528. 20 lines. Explanation level: test-overview.

This behavior fixture supplies concrete inputs and checks only the stated contract. Read its test titles with the corresponding chapter: each expectation demonstrates a supported observation, rejected boundary or unchanged negative. Full individual statement annotations remain a recorded learning gap.

### Lines 1-20

Complete file excerpt for review alongside its responsibility above.

```
   1 import { describe, expect, it } from "vitest";
   2 import { runAnalysis } from "../dist/analysis.js";
   3 import type { AnalysisInput } from "../src/analysis.js";
   4
   5 const input: AnalysisInput = { before: [], after: [], config: {}, manifest: { schemaVersion: 1, comparison: { requestedBase: "b", requestedHead: "h", resolvedBase: "a".repeat(40), resolvedHead: "b".repeat(40), comparisonBase: "a".repeat(40), policy: "exact" }, before: [], after: [], diagnostics: [], totalBytes: 0 } };
   6 describe("killable bounded semantic analysis", () => {
   7   it("returns a validated result from the actual compiled worker", async () => {
   8     expect((await runAnalysis(input)).findings).toEqual([]);
   9   });
  10   it("enforces a deadline and cancellation while waiting for termination", async () => {
  11     await expect(runAnalysis(input, undefined, 1)).rejects.toThrow(/deadline/);
  12     const controller = new AbortController();
  13     const result = runAnalysis(input, controller.signal);
  14     setTimeout(() => controller.abort(), 5);
  15     await expect(result).rejects.toThrow(/canceled/);
  16   });
  17   it("rejects excessive input before creating a worker", async () => {
  18     await expect(runAnalysis({ ...input, before: Array.from({ length: 4001 }, () => ({ path: "x.ts", revision: "a", content: "" })) })).rejects.toThrow(/limits/);
  19   });
  20 });
```

## packages/lens/test/artifacts.test.ts

Source digest: 3238f4a28cb0ef0efad1eadc9fb699614c3858635196f3b0a731d3b1bb8dab86. 35 lines. Explanation level: test-overview.

This behavior fixture supplies concrete inputs and checks only the stated contract. Read its test titles with the corresponding chapter: each expectation demonstrates a supported observation, rejected boundary or unchanged negative. Full individual statement annotations remain a recorded learning gap.

### Lines 1-35

Complete file excerpt for review alongside its responsibility above.

```
   1 import { describe, expect, it } from "vitest";
   2 import { attachTestArtifact, expectedArtifact } from "../src/artifacts.js";
   3 import { compareFiles } from "../src/compare.js";
   4 import { render } from "../src/render.js";
   5 import type { Manifest } from "../src/contracts.js";
   6
   7 const manifest: Manifest = { schemaVersion: 1, comparison: { requestedBase: "b", requestedHead: "h", resolvedBase: "a".repeat(40), resolvedHead: "b".repeat(40), comparisonBase: "a".repeat(40), policy: "exact" }, before: [], after: [], diagnostics: [], totalBytes: 0 };
   8 const files = [{ path: "api.ts", content: "export function a() {}", revision: "b".repeat(40) }];
   9 const report = () => compareFiles(files, files, manifest);
  10 describe("supplied test-artifact provenance", () => {
  11   it.each(["head", "comparisonBase", "configDigest", "files"])("excludes mismatched %s metadata with exact labeled artifact evidence", field => {
  12     const baseline = report();
  13     const artifact = expectedArtifact(baseline, files);
  14     if (field === "files") artifact.files = {};
  15     else artifact[field as "head"] = "0".repeat(field === "configDigest" ? 64 : 40);
  16     const content = JSON.stringify(artifact, null, 2);
  17     const result = attachTestArtifact(baseline, content, files);
  18     expect(result.findings.map(item => item.ruleId)).toEqual(["EVIDENCE001"]);
  19     expect(result.findings[0]?.before).toMatchObject({ method: "supplied-artifact", excerpt: content });
  20     expect(result.findings[0]?.after.method).toBe("derived-run-context");
  21     expect(result.run.completeness).toBe("partial");
  22     expect(render(result, "terminal")).toContain("[supplied-artifact]");
  23   });
  24   it("does not treat self-consistent claims as authenticated origin or per-test coverage", () => {
  25     const baseline = report();
  26     const result = attachTestArtifact(baseline, JSON.stringify(expectedArtifact(baseline, files)), files);
  27     expect(result.findings).toEqual([]);
  28     expect(result.run.diagnostics.some(item => item.code === "artifact-unverified")).toBe(true);
  29     expect(result.run.completeness).toBe("partial");
  30     expect(baseline.run.diagnostics).toEqual([]);
  31   });
  32   it("rejects malformed, oversized and wrong-version artifacts without an invented successful report", () => {
  33     for (const content of ["{", "x".repeat(65537), JSON.stringify({ ...expectedArtifact(report(), files), schemaVersion: 2 })]) expect(() => attachTestArtifact(report(), content, files)).toThrow();
  34   });
  35 });
```

## packages/lens/test/cli.test.ts

Source digest: 9e37ea3333c67c6d759dd07d422bfe0356ee09a8eee63564f78232aaf10c717c. 43 lines. Explanation level: test-overview.

This behavior fixture supplies concrete inputs and checks only the stated contract. Read its test titles with the corresponding chapter: each expectation demonstrates a supported observation, rejected boundary or unchanged negative. Full individual statement annotations remain a recorded learning gap.

### Lines 1-43

Complete file excerpt for review alongside its responsibility above.

```
   1 import { execFile } from "node:child_process";
   2 import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
   3 import { tmpdir } from "node:os";
   4 import { join, resolve } from "node:path";
   5 import { promisify } from "node:util";
   6 import { describe, expect, it } from "vitest";
   7
   8 const run = promisify(execFile);
   9 const cli = resolve("dist/cli.js");
  10 describe("CLI exit and output contract", () => {
  11   it("uses exit 2 for invalid options while help remains successful", async () => {
  12     await expect(run(process.execPath, [cli, "review", "--base", "HEAD", "--format", "bad"])).rejects.toMatchObject({ code: 2 });
  13     expect((await run(process.execPath, [cli, "--help"])).stdout).toContain("review");
  14   });
  15   it("writes a valid report before opt-in policy failure and writes partial reports", async () => {
  16     const root = await mkdtemp(join(tmpdir(), "lens-cli-report-"));
  17     try {
  18       const evaluation = JSON.parse(await readFile(resolve("../../output/evaluation.json"), "utf8"));
  19       const env = { ...process.env, LENS_WORKER: resolve("../../target/debug/lens-snapshot" + (process.platform === "win32" ? ".exe" : "")) };
  20       const reportPath = join(root, "report.json");
  21       const args = [cli, "review", "--repo", evaluation.repository, "--base", evaluation.commits.base, "--head", evaluation.commits.head, "--policy", "exact", "--format", "json", "--output", reportPath];
  22       await expect(run(process.execPath, [...args, "--fail-on-findings"], { env, timeout: 10000 })).rejects.toMatchObject({ code: 4 });
  23       const baseline = JSON.parse(await readFile(reportPath, "utf8"));
  24       expect(baseline.findings.length).toBeGreaterThan(0);
  25       const artifact = join(root, "artifact.json");
  26       await writeFile(artifact, JSON.stringify({ schemaVersion: 1, kind: "test-provenance", comparisonBase: baseline.run.comparison.comparisonBase, head: "0".repeat(40), configDigest: baseline.run.configDigest, files: {} }));
  27       await expect(run(process.execPath, [...args, "--test-artifact", artifact], { env, timeout: 10000 })).rejects.toMatchObject({ code: 3 });
  28       expect(JSON.parse(await readFile(reportPath, "utf8")).findings.some((finding: { ruleId: string }) => finding.ruleId === "EVIDENCE001")).toBe(true);
  29       const partialRepo = join(root, "partial-repo");
  30       await run("git", ["clone", "--no-local", "--quiet", evaluation.repository, partialRepo]);
  31       const git = async (...values: string[]) => (await run("git", ["-C", partialRepo, ...values])).stdout.trim();
  32       await git("config", "user.name", "Lens CLI fixture");
  33       await git("config", "user.email", "fixture@example.invalid");
  34       await git("config", "commit.gpgsign", "false");
  35       await writeFile(join(partialRepo, "README.md"), "Excluded context is visible\n");
  36       await git("add", "README.md"); await git("commit", "-m", "excluded context");
  37       const partialHead = await git("rev-parse", "HEAD");
  38       await expect(run(process.execPath, [cli, "review", "--repo", partialRepo, "--base", evaluation.commits.base, "--head", partialHead, "--policy", "exact", "--format", "json", "--output", reportPath], { env, timeout: 10000 })).rejects.toMatchObject({ code: 3 });
  39       expect(JSON.parse(await readFile(reportPath, "utf8")).run.completeness).toBe("partial");
  40       expect((await run(process.execPath, [cli, "rules"], { env })).stdout).toContain("EVIDENCE001 checks metadata");
  41     } finally { await rm(root, { recursive: true, force: true }); }
  42   }, 15000);
  43 });
```

## packages/lens/test/fake-worker.mjs

Source digest: 12fabe779d095cf12e6f8680590cfe5d7fee08ccec413c48a4138b5384e9dc98. 20 lines. Explanation level: test-overview.

This behavior fixture supplies concrete inputs and checks only the stated contract. Read its test titles with the corresponding chapter: each expectation demonstrates a supported observation, rejected boundary or unchanged negative. Full individual statement annotations remain a recorded learning gap.

### Lines 1-20

Complete file excerpt for review alongside its responsibility above.

```
   1 let input = "";
   2 for await (const chunk of process.stdin) input += chunk;
   3 const request = JSON.parse(input);
   4 const mode = process.argv[2];
   5 const manifest = { schemaVersion: 1, comparison: { requestedBase: request.base, requestedHead: request.head, resolvedBase: "a".repeat(40), resolvedHead: "b".repeat(40), comparisonBase: "a".repeat(40), policy: request.policy }, before: [], after: [], diagnostics: [], totalBytes: 0 };
   6 const response = { protocolVersion: 1, id: request.id, type: "result", manifest, complete: true };
   7 if (mode === "hang") { setInterval(() => {}, 1000); }
   8 else if (mode === "crash") process.exit(8);
   9 else if (mode === "oversized") process.stdout.write("x".repeat(17 * 1024 * 1024));
  10 else if (mode === "stderr") process.stderr.write("x".repeat(65537));
  11 else if (mode === "invalid-utf8") process.stdout.write(Buffer.from([0xff, 10]));
  12 else if (mode === "invalid-json") console.log("not json");
  13 else if (mode === "truncated") process.stdout.write(JSON.stringify(response));
  14 else if (mode === "extra") { console.log(JSON.stringify(response)); console.log(JSON.stringify(response)); }
  15 else {
  16   if (mode === "wrong-version") response.protocolVersion = 2;
  17   if (mode === "wrong-id") response.id = "different";
  18   if (mode === "unsafe-path") manifest.before.push({ path: "../escape.ts", digest: "a".repeat(64), storage: "a".repeat(64) + ".txt", bytes: 1 });
  19   console.log(JSON.stringify(response));
  20 }
```

## packages/lens/test/fixtures.test.ts

Source digest: 957a87890e2699bdc8b6f8092efb7e9ca106f2928ca6c72898cc5cd94aec137d. 91 lines. Explanation level: test-overview.

This behavior fixture supplies concrete inputs and checks only the stated contract. Read its test titles with the corresponding chapter: each expectation demonstrates a supported observation, rejected boundary or unchanged negative. Full individual statement annotations remain a recorded learning gap.

### Lines 1-91

Complete file excerpt for review alongside its responsibility above.

```
   1 import { describe, expect, it } from "vitest";
   2 import { compareFiles } from "../src/compare.js";
   3 import { extract } from "../src/extract.js";
   4 import type { InputFile } from "../src/extract.js";
   5 import type { Manifest } from "../src/contracts.js";
   6
   7 export const manifest: Manifest = { schemaVersion: 1, comparison: { requestedBase: "base", requestedHead: "head", resolvedBase: "a".repeat(40), resolvedHead: "b".repeat(40), comparisonBase: "a".repeat(40), policy: "exact" }, before: [], after: [], diagnostics: [], totalBytes: 0 };
   8 function file(content: string, path = "api.ts", revision = "a".repeat(40)): InputFile { return { content, path, revision }; }
   9 function compare(before: string, after: string) { return compareFiles([file(before)], [file(after, "api.ts", "b".repeat(40))], manifest); }
  10
  11 describe("signature fixture vertical slice", () => {
  12   it("detects a required parameter becoming optional with exact UTF-16 coordinates", () => {
  13     const report = compare("// Unicode: 🧭\r\nexport function load(id: string): string { return id; }", "// Unicode: 🧭\r\nexport function load(id?: string): string { return id ?? ''; }");
  14     expect(report.findings.map(item => item.ruleId)).toEqual(["API001"]);
  15     expect(report.findings[0]?.before).toMatchObject({ path: "api.ts", startLine: 2, startColumn: 1, revision: "a".repeat(40) });
  16     expect(report.findings[0]?.after.excerpt).toContain("id?: string");
  17   });
  18   it("does not report body-only edits or unchanged code", () => {
  19     expect(compare("export function load(id: string): string { return id; }", "export function load(id: string): string { return id.trim(); }").findings).toEqual([]);
  20     expect(compare("export function a() {}", "export function a() {}").findings).toEqual([]);
  21   });
  22   it("records unsupported and malformed input rather than fabricating comparisons", () => {
  23     for (const source of ["export const load = () => 1;", "export function load<T>(id: T): T { return id; }", "export function load( {"]) {
  24       const report = compare(source, source);
  25       expect(report.findings).toEqual([]);
  26       expect(report.run.completeness).toBe("partial");
  27       expect(report.run.diagnostics.length).toBeGreaterThan(0);
  28     }
  29   });
  30   it("supports explicit returns and required interface fields", () => {
  31     const report = compare("export function a(): string { return ''; } export interface User { id: string; }", "export function a(): number { return 1; } export interface User { id?: string; }");
  32     expect(report.findings.map(item => item.ruleId).sort()).toEqual(["API002", "TYPE001"]);
  33   });
  34   it("pairs a missing guard and changed assertion using an aliased import", () => {
  35     const before = [file("export function save() { own(); return 1; }"), file("import { it, expect } from 'vitest'; import { save as persist } from './api'; it('rejects', () => { expect(persist()).toThrow(); });", "api.test.ts")];
  36     const after = [file("export function save() { return 1; }"), file("import { it, expect } from 'vitest'; import { save as persist } from './api'; it.skip('rejects', () => { persist(); });", "api.test.ts")];
  37     const report = compareFiles(before, after, manifest, { guards: ["own"] });
  38     expect(report.findings.map(item => item.ruleId).sort()).toEqual(["GUARD001", "TEST001", "TEST002"]);
  39     const guard = report.findings.find(item => item.ruleId === "GUARD001")!;
  40     expect(guard.strength).toBe("heuristic");
  41     expect(guard.before.excerpt).toBe("own()");
  42     expect(guard.symbol).toBe("api.ts#save");
  43     expect(guard.relatedTests[0]).toMatchObject({ name: "rejects", method: "static-import-reference" });
  44     expect(guard.relatedTests[0]?.changes).toHaveLength(2);
  45   });
  46   it("does not treat nested helper guard calls as function protection", () => {
  47     const facts = extract(file("export function save() { const helper = () => own(); }"), ["own"]);
  48     expect([...facts.functions[0]!.guards]).toEqual([]);
  49   });
  50   it("does not match duplicate tests or execute arbitrary expect names", () => {
  51     const source = "function expect(x: number) { return x; } test('x', () => { expect(1); });";
  52     expect(extract(file(source), []).tests).toEqual([]);
  53     const duplicate = "import { it, expect } from 'vitest'; it('x', () => { expect(1).toBe(1); }); it('x', () => { expect(2).toBe(2); });";
  54     expect(compare(duplicate, duplicate).run.diagnostics.some(item => item.code === "ambiguous-test")).toBe(true);
  55   });
  56   it("preserves guards/assertions moved within their matched scope", () => {
  57     const before = "export function save() { own(); const x = 1; return x; }";
  58     const after = "export function save() { const x = 1; own(); return x; }";
  59     expect(compareFiles([file(before)], [file(after)], manifest, { guards: ["own"] }).findings).toEqual([]);
  60     expect(compareFiles([file("export function x() { auth.own(); }")], [file("export function x() { auth . own(); }")], manifest, { guards: ["auth.own"] }).findings).toEqual([]);
  61     const test = "import { it, expect } from 'vitest'; it('a', () => { expect(1).toBe(1); });";
  62     expect(compare(test, test.replace("expect(1)", "const moved = 1; expect(1)")).findings).toEqual([]);
  63   });
  64   it("does not establish test relationships through shadowed import names", () => {
  65     const before = [file("export function save() { own(); }"), file("import { it } from 'vitest'; import { save } from './api'; it('x', () => { const save = () => 1; save(); });", "api.test.ts")];
  66     const after = [{ ...before[0]!, content: "export function save() {}" }, before[1]!];
  67     const report = compareFiles(before, after, manifest, { guards: ["own"] });
  68     expect(report.findings.find(item => item.ruleId === "GUARD001")?.relatedTests).toEqual([]);
  69   });
  70   it("labels assertion edits/additions and explicitly excludes unsupported matchers", () => {
  71     const baseline = "import { it, expect } from 'vitest'; it('x', () => { expect(1).toBe(1); });";
  72     expect(compare(baseline, baseline.replace("toBe(1)", "toBe(2)")).findings[0]?.reason).toContain("edited");
  73     expect(compare(baseline, baseline.replace("expect(1).toBe(1);", "expect(1).toBe(1); expect(2).toEqual(2);")).findings[0]?.reason).toContain("added");
  74     expect(compare(baseline, baseline.replace("toBe(1)", "customMatcher(1)")).run.diagnostics.some(item => item.code === "unsupported-assertion")).toBe(true);
  75   });
  76   it("detects todo while unchanged optional fields/defaults remain negative", () => {
  77     const baseline = "import { it, expect } from 'vitest'; it('x', () => { expect(1).toBe(1); });";
  78     expect(compare(baseline, "import { it } from 'vitest'; it.todo('x');").findings.map(item => item.ruleId).sort()).toEqual(["TEST001", "TEST002"]);
  79     const unchanged = "export interface X { id?: string; } export function a(x = 1) { return x; }";
  80     expect(compare(unchanged, unchanged).findings).toEqual([]);
  81   });
  82   it("marks each/conditional/dynamic-suite forms unsupported instead of silently empty", () => {
  83     for (const source of ["it.each([1])('x', () => {});", "it.skipIf(true)('x', () => {});", "it(name, () => {});", "describe.skip('suite', () => { it('x', () => {}); });"]) {
  84       const input = "import { it, describe } from 'vitest'; " + source;
  85       const report = compare(input, input);
  86       expect(report.run.completeness).toBe("partial");
  87       expect(report.run.diagnostics.some(item => item.code === "unsupported-test")).toBe(true);
  88       expect(report.findings).toEqual([]);
  89     }
  90   });
  91 });
```

## packages/lens/test/git.test.ts

Source digest: ce358a23c9a7d5f0f03b681359e2a8b30713b535a8081a9f69f2c0bb2f046280. 133 lines. Explanation level: test-overview.

This behavior fixture supplies concrete inputs and checks only the stated contract. Read its test titles with the corresponding chapter: each expectation demonstrates a supported observation, rejected boundary or unchanged negative. Full individual statement annotations remain a recorded learning gap.

### Lines 1-133

Complete file excerpt for review alongside its responsibility above.

```
   1 import { execFile, execFileSync } from "node:child_process";
   2 import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
   3 import { tmpdir } from "node:os";
   4 import { join, resolve } from "node:path";
   5 import { promisify } from "node:util";
   6 import { afterEach, describe, expect, it } from "vitest";
   7 import { capture } from "../src/snapshot.js";
   8 import { compareFiles } from "../src/compare.js";
   9
  10 const run = promisify(execFile);
  11 const worker = resolve("../../target/debug/lens-snapshot" + (process.platform === "win32" ? ".exe" : ""));
  12 const roots: string[] = [];
  13 async function repository() {
  14   const root = await mkdtemp(join(tmpdir(), "lens-git-"));
  15   roots.push(root);
  16   const git = async (...args: string[]) => (await run("git", ["-C", root, ...args], { timeout: 10000 })).stdout.trim();
  17   await git("init", "-b", "main");
  18   await git("config", "user.name", "Lens fixture");
  19   await git("config", "user.email", "fixture@example.invalid");
  20   await git("config", "core.autocrlf", "false");
  21   return { root, git, commit: async (message: string) => { await git("add", "."); await git("commit", "-m", message); return git("rev-parse", "HEAD"); } };
  22 }
  23 afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  24
  25 describe("real Rust immutable Git worker", () => {
  26   it("reads committed blobs, preserves dirty source, and reports actual revisions", async () => {
  27     const repo = await repository();
  28     const path = join(repo.root, "日本語 with space.ts");
  29     await writeFile(path, "\uFEFF// 🧭\r\nexport function load(id: string): string { return id; }\r\n");
  30     const base = await repo.commit("required");
  31     await writeFile(path, "// 🧭\r\nexport function load(id?: string): string { return id ?? ''; }\r\n");
  32     const head = await repo.commit("optional");
  33     await writeFile(path, "this dirty file must not be analyzed");
  34     const status = await repo.git("status", "--porcelain");
  35     const result = await capture(repo.root, base, head, "exact", undefined, worker);
  36     expect(result.manifest.comparison).toMatchObject({ resolvedBase: base, resolvedHead: head, comparisonBase: base, policy: "exact" });
  37     const report = compareFiles(result.before, result.after, result.manifest);
  38     expect(report.findings.map(item => item.ruleId)).toEqual(["API001"]);
  39     expect(report.findings[0]?.before).toMatchObject({ path: "日本語 with space.ts", startLine: 2 });
  40     expect(result.before[0]?.content.charCodeAt(0)).toBe(0xfeff);
  41     expect(report.findings[0]?.before.fileDigest).toBe(result.manifest.before[0]?.digest);
  42     expect(await repo.git("status", "--porcelain")).toBe(status);
  43     expect(await readFile(path, "utf8")).toBe("this dirty file must not be analyzed");
  44   });
  45   it("distinguishes PR merge-base from exact base on divergent history", async () => {
  46     const repo = await repository();
  47     await writeFile(join(repo.root, "api.ts"), "export function load(id: string) {}\n");
  48     const ancestor = await repo.commit("ancestor");
  49     await repo.git("checkout", "-b", "feature");
  50     await writeFile(join(repo.root, "api.ts"), "export function load(id?: string) {}\n");
  51     const head = await repo.commit("feature");
  52     await repo.git("checkout", "main");
  53     await writeFile(join(repo.root, "api.ts"), "export function load(id?: string) {}\n");
  54     const base = await repo.commit("base tip");
  55     const pr = await capture(repo.root, base, head, "pr", undefined, worker);
  56     const exact = await capture(repo.root, base, head, "exact", undefined, worker);
  57     expect(pr.manifest.comparison.comparisonBase).toBe(ancestor);
  58     expect(exact.manifest.comparison.comparisonBase).toBe(base);
  59     expect(compareFiles(pr.before, pr.after, pr.manifest).findings).toHaveLength(1);
  60     expect(compareFiles(exact.before, exact.after, exact.manifest).findings).toEqual([]);
  61   });
  62   it("handles addition/deletion/identical rename and visibly excludes unsupported files", async () => {
  63     const repo = await repository();
  64     await writeFile(join(repo.root, "old.ts"), "export function old() {}\n");
  65     await writeFile(join(repo.root, "delete.ts"), "export function gone() {}\n");
  66     await writeFile(join(repo.root, "README.md"), "not TypeScript");
  67     const base = await repo.commit("before");
  68     await repo.git("mv", "old.ts", "renamed.ts");
  69     await repo.git("rm", "delete.ts");
  70     await writeFile(join(repo.root, "new.ts"), "export function added() {}\n");
  71     const head = await repo.commit("after");
  72     const result = await capture(repo.root, base, head, "exact", undefined, worker);
  73     const report = compareFiles(result.before, result.after, result.manifest);
  74     expect(report.symbols.find(item => item.name === "old")?.matching).toBe("identical-blob-rename");
  75     expect(report.run.diagnostics.some(item => item.code === "unsupported-file")).toBe(true);
  76     expect(report.run.diagnostics.some(item => item.path === "delete.ts" && item.code === "unmatched-file")).toBe(true);
  77     expect(report.run.completeness).toBe("partial");
  78   });
  79   it("fails for missing history or option-looking refs rather than returning zero findings", async () => {
  80     const repo = await repository();
  81     await writeFile(join(repo.root, "api.ts"), "export function a() {}\n");
  82     await repo.commit("base");
  83     for (const base of ["missing", "--all"]) await expect(capture(repo.root, base, "HEAD", "pr", undefined, worker)).rejects.toThrow(/snapshot_failed/);
  84   });
  85   it("captures project configuration and resolves path-aliased calls across revisions", async () => {
  86     const repo = await repository();
  87     await writeFile(join(repo.root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@helpers": ["helpers.ts"] } } }));
  88     await writeFile(join(repo.root, "helpers.ts"), "export function one() {} export function two() {}\n");
  89     await writeFile(join(repo.root, "api.ts"), "import { one as use } from '@helpers'; export function run() { use(); }\n");
  90     const base = await repo.commit("project before");
  91     await writeFile(join(repo.root, "api.ts"), "import { two as use } from '@helpers'; export function run() { use(); }\n");
  92     const head = await repo.commit("project after");
  93     const result = await capture(repo.root, base, head, "exact", undefined, worker);
  94     expect(result.before.some(entry => entry.path === "tsconfig.json")).toBe(true);
  95     expect(compareFiles(result.before, result.after, result.manifest).findings.map(item => item.ruleId)).toEqual(["CALL001"]);
  96   });
  97   it("does not silently fetch missing shallow history", async () => {
  98     const repo = await repository();
  99     await writeFile(join(repo.root, "api.ts"), "export function a() {}\n");
 100     const base = await repo.commit("ancestor");
 101     await writeFile(join(repo.root, "api.ts"), "export function a(x?: string) {}\n");
 102     await repo.commit("tip");
 103     const shallow = join(repo.root, "shallow-clone");
 104     await run("git", ["clone", "--depth", "1", "--no-local", "--quiet", repo.root, shallow]);
 105     await expect(capture(shallow, base, "HEAD", "pr", undefined, worker)).rejects.toThrow(/snapshot_failed/);
 106   });
 107   it("classifies Git symlink/submodule, binary and LFS entries without materializing them", async () => {
 108     const repo = await repository();
 109     await writeFile(join(repo.root, "api.ts"), "export function a() {}\n");
 110     const base = await repo.commit("base");
 111     const blob = execFileSync("git", ["-C", repo.root, "hash-object", "-w", "--stdin"], { input: "api.ts" }).toString().trim();
 112     execFileSync("git", ["-C", repo.root, "update-index", "-z", "--index-info"], { input: `120000 blob ${blob}\tlink.ts\0` + `160000 commit ${base}\tsubmodule\0` });
 113     await writeFile(join(repo.root, "binary.ts"), Buffer.from([0, 1, 2]));
 114     await writeFile(join(repo.root, "lfs.ts"), "version https://git-lfs.github.com/spec/v1\noid sha256:example\nsize 1\n");
 115     await repo.git("add", "binary.ts", "lfs.ts");
 116     const tree = await repo.git("write-tree");
 117     const head = await repo.git("commit-tree", tree, "-p", base, "-m", "unsupported modes");
 118     const result = await capture(repo.root, base, head, "exact", undefined, worker);
 119     expect(result.manifest.diagnostics.map(entry => entry.code).sort()).toEqual(["submodule", "symlink", "unsupported-content", "unsupported-content"]);
 120     expect(result.after.map(entry => entry.path)).toEqual(["api.ts"]);
 121   });
 122   it("rejects a non-UTF-8 historical Git path without silently replacing characters", async () => {
 123     const repo = await repository();
 124     await writeFile(join(repo.root, "api.ts"), "export function a() {}\n");
 125     const base = await repo.commit("base");
 126     const blob = execFileSync("git", ["-C", repo.root, "hash-object", "-w", "--stdin"], { input: "export function x() {}" }).toString().trim();
 127     const index = Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), Buffer.from([0xff]), Buffer.from(".ts\0")]);
 128     execFileSync("git", ["-C", repo.root, "update-index", "-z", "--index-info"], { input: index });
 129     const tree = await repo.git("write-tree");
 130     const head = await repo.git("commit-tree", tree, "-p", base, "-m", "invalid path encoding");
 131     await expect(capture(repo.root, base, head, "exact", undefined, worker)).rejects.toThrow(/non-UTF-8 Git paths/);
 132   });
 133 });
```

## packages/lens/test/io.test.ts

Source digest: 08b5250c51cb1bc3aa9ce828b01a0be9cd5250d93de96e83be812c5931dca246. 21 lines. Explanation level: test-overview.

This behavior fixture supplies concrete inputs and checks only the stated contract. Read its test titles with the corresponding chapter: each expectation demonstrates a supported observation, rejected boundary or unchanged negative. Full individual statement annotations remain a recorded learning gap.

### Lines 1-21

Complete file excerpt for review alongside its responsibility above.

```
   1 import { mkdtemp, rm, writeFile } from "node:fs/promises";
   2 import { tmpdir } from "node:os";
   3 import { join } from "node:path";
   4 import { describe, expect, it } from "vitest";
   5 import { readBoundedFile, readBoundedText } from "../src/io.js";
   6
   7 describe("bounded file and UTF-8 reads", () => {
   8   it("accepts an exact-size UTF-8 file and rejects excessive or malformed input", async () => {
   9     const root = await mkdtemp(join(tmpdir(), "lens-read-"));
  10     try {
  11       const file = join(root, "input.json");
  12       await writeFile(file, "🧭");
  13       expect(await readBoundedText(file, 4)).toBe("🧭");
  14       await expect(readBoundedFile(file, 3)).rejects.toThrow(/at most/);
  15       await writeFile(file, Buffer.from([0xff]));
  16       await expect(readBoundedText(file, 4)).rejects.toThrow();
  17       await writeFile(file, "\uFEFF🧭");
  18       expect(await readBoundedText(file, 7)).toBe("\uFEFF🧭");
  19     } finally { await rm(root, { recursive: true, force: true }); }
  20   });
  21 });
```

## packages/lens/test/links.test.ts

Source digest: 87c64ebe8cd2706165a51454558e858ae6d9d459348066821c9e5654cfbe5b6f. 21 lines. Explanation level: test-overview.

This behavior fixture supplies concrete inputs and checks only the stated contract. Read its test titles with the corresponding chapter: each expectation demonstrates a supported observation, rejected boundary or unchanged negative. Full individual statement annotations remain a recorded learning gap.

### Lines 1-21

Complete file excerpt for review alongside its responsibility above.

```
   1 import { describe, expect, it } from "vitest";
   2 import { sourceUrl, sourceUrlPattern } from "../src/links.js";
   3 import { compareFiles } from "../src/compare.js";
   4 import type { Manifest } from "../src/contracts.js";
   5
   6 describe("revision-specific source links", () => {
   7   it("encodes path segments and excludes end-exclusive line starts", () => {
   8     const url = sourceUrl("https://github.com/owner/repo/", "a".repeat(40), "src/日本語 (x)#.ts", 2, 5, 1)!;
   9     expect(url).toContain("src/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%28x%29%23.ts#L2-L4");
  10     expect(sourceUrlPattern.test(url)).toBe(true);
  11     for (const origin of ["javascript:alert(1)", "https://evil.invalid/o/r", "https://github.com@evil.invalid/o/r"]) expect(sourceUrl(origin, "a".repeat(40), "a.ts", 1, 1, 4)).toBeUndefined();
  12   });
  13   it("uses comparison base for removed code and resolved head for added code", () => {
  14     const manifest: Manifest = { schemaVersion: 1, comparison: { requestedBase: "b", requestedHead: "h", resolvedBase: "c".repeat(40), resolvedHead: "b".repeat(40), comparisonBase: "a".repeat(40), policy: "pr" }, before: [], after: [], diagnostics: [], totalBytes: 0 };
  15     const before = [{ path: "a.ts", revision: manifest.comparison.comparisonBase, content: "export function a(x: string) {}" }];
  16     const after = [{ ...before[0]!, revision: manifest.comparison.resolvedHead, content: "export function a(x?: string) {}" }];
  17     const report = compareFiles(before, after, manifest, { repositoryUrl: "https://github.com/owner/repo" });
  18     expect(report.findings[0]?.before.url).toContain(`/blob/${"a".repeat(40)}/`);
  19     expect(report.findings[0]?.after.url).toContain(`/blob/${"b".repeat(40)}/`);
  20   });
  21 });
```

## packages/lens/test/project.test.ts

Source digest: 20485f0f5d42cb6f5a36b470874b3ed6ee461f92e5d828c1369a59d8a0b795fd. 60 lines. Explanation level: test-overview.

This behavior fixture supplies concrete inputs and checks only the stated contract. Read its test titles with the corresponding chapter: each expectation demonstrates a supported observation, rejected boundary or unchanged negative. Full individual statement annotations remain a recorded learning gap.

### Lines 1-60

Complete file excerpt for review alongside its responsibility above.

```
   1 import { describe, expect, it } from "vitest";
   2 import { compareFiles } from "../src/compare.js";
   3 import { createProject } from "../src/project.js";
   4 import { loadTrustedLibraries } from "../src/libraries.js";
   5 import type { InputFile } from "../src/extract.js";
   6 import type { Manifest } from "../src/contracts.js";
   7
   8 const manifest: Manifest = { schemaVersion: 1, comparison: { requestedBase: "b", requestedHead: "h", resolvedBase: "a".repeat(40), resolvedHead: "b".repeat(40), comparisonBase: "a".repeat(40), policy: "exact" }, before: [], after: [], diagnostics: [], totalBytes: 0 };
   9 const file = (path: string, content: string): InputFile => ({ path, content, revision: "a".repeat(40) });
  10 describe("snapshot project context and resolved calls", () => {
  11   it("resolves aliases through captured modules and identifies changed direct targets", () => {
  12     const functions = file("helpers.ts", "export function first() { return 1; } export function second() { return 2; }");
  13     const before = [functions, file("api.ts", "import { first as helper } from './helpers'; export function save() { return helper(); }")];
  14     const after = [functions, file("api.ts", "import { second as helper } from './helpers'; export function save() { return helper(); }")];
  15     const report = compareFiles(before, after, manifest);
  16     expect(report.findings.map(item => item.ruleId)).toEqual(["CALL001"]);
  17     expect(report.findings[0]?.reason).toContain("helpers.ts#first");
  18     expect(report.findings[0]?.reason).toContain("helpers.ts#second");
  19   });
  20   it("does not report a local import alias rename as a different target", () => {
  21     const helper = file("helper.ts", "export function load() { return 1; }");
  22     const before = file("api.ts", "import { load as a } from './helper'; export function read() { return a(); }");
  23     const after = file("api.ts", "import { load as b } from './helper'; export function read() { return b(); }");
  24     expect(compareFiles([helper, before], [helper, after], manifest).findings).toEqual([]);
  25   });
  26   it("uses captured tsconfig baseUrl/paths and local extends without reading disk", () => {
  27     const config = file("tsconfig.json", JSON.stringify({ extends: "./tsconfig.base.json", compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/*"] } } }));
  28     const base = file("tsconfig.base.json", JSON.stringify({ compilerOptions: { module: "commonjs", moduleResolution: "node", target: "es2022" } }));
  29     const helpers = file("src/helpers.ts", "export function one() {} export function two() {}");
  30     const before = [config, base, helpers, file("api.ts", "import { one as use } from '@lib/helpers'; export function run() { use(); }")];
  31     const after = [config, base, helpers, file("api.ts", "import { two as use } from '@lib/helpers'; export function run() { use(); }")];
  32     expect(compareFiles(before, after, manifest).findings.map(item => item.ruleId)).toEqual(["CALL001"]);
  33   });
  34   it("reports outside-root extends and missing call context rather than forcing a target", () => {
  35     const files = [file("tsconfig.json", JSON.stringify({ extends: "../../outside.json" })), file("api.ts", "import { missing } from 'not-installed'; export function run() { missing(); }")];
  36     const report = compareFiles(files, files, manifest);
  37     expect(report.findings).toEqual([]);
  38     expect(report.run.completeness).toBe("partial");
  39     expect(report.run.diagnostics.some(item => item.code === "config-error")).toBe(true);
  40     expect(report.run.diagnostics.some(item => item.code === "unresolved-calls")).toBe(true);
  41     expect(createProject(files).program.getSourceFiles().every(source => source.fileName.startsWith("/__lens_snapshot__/"))).toBe(true);
  42   });
  43   it("reads standard declarations only from explicitly supplied trusted compiler strings", async () => {
  44     const libraries = await loadTrustedLibraries();
  45     expect(libraries.some(entry => entry.path === "lib.es2022.full.d.ts")).toBe(true);
  46     const files = [file("api.ts", "export function trim(value: string): string { return value.trim(); }")];
  47     const report = compareFiles(files, files, manifest, {}, libraries);
  48     expect(report.findings).toEqual([]);
  49     expect(report.run.diagnostics.filter(item => item.code === "unresolved-calls")).toEqual([]);
  50   });
  51   it("links a configured-path import to the actual changed symbol", () => {
  52     const config = file("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@api": ["api.ts"] } } }));
  53     const test = file("api.test.ts", "import { it } from 'vitest'; import { save as persist } from '@api'; it('x', () => { persist('x'); });");
  54     const before = [config, test, file("api.ts", "export function save(id: string) { return id; }")];
  55     const after = [config, test, file("api.ts", "export function save(id?: string) { return id; }")];
  56     const result = compareFiles(before, after, manifest);
  57     expect(result.findings[0]?.ruleId).toBe("API001");
  58     expect(result.findings[0]?.relatedTests[0]?.name).toBe("x");
  59   });
  60 });
```

## packages/lens/test/protocol.test.ts

Source digest: ff07e62ebc4af1d753d75f73d0d8ea9d6e25ba0c9d76f9d1d1f2bb2abb39a144. 32 lines. Explanation level: test-overview.

This behavior fixture supplies concrete inputs and checks only the stated contract. Read its test titles with the corresponding chapter: each expectation demonstrates a supported observation, rejected boundary or unchanged negative. Full individual statement annotations remain a recorded learning gap.

### Lines 1-32

Complete file excerpt for review alongside its responsibility above.

```
   1 import { randomUUID } from "node:crypto";
   2 import { spawnSync } from "node:child_process";
   3 import { resolve } from "node:path";
   4 import { describe, expect, it } from "vitest";
   5 import { invokeWorker } from "../src/snapshot.js";
   6
   7 const request = () => ({ protocolVersion: 1, id: randomUUID(), operation: "snapshot", repo: process.cwd(), git: process.execPath, output: process.cwd(), base: "base", head: "head", policy: "exact" });
   8 const fake = resolve("test/fake-worker.mjs");
   9 describe("bounded worker process boundary", () => {
  10   it.each(["wrong-version", "wrong-id", "unsafe-path", "invalid-json", "invalid-utf8", "truncated", "extra", "crash", "oversized", "stderr"])("rejects %s output", async mode => {
  11     await expect(invokeWorker(request(), process.execPath, undefined, 5000, [fake, mode])).rejects.toThrow();
  12   });
  13   it("times out and awaits process termination", async () => {
  14     await expect(invokeWorker(request(), process.execPath, undefined, 100, [fake, "hang"])).rejects.toThrow(/timeout/);
  15   });
  16   it("cancels a running worker", async () => {
  17     const controller = new AbortController();
  18     const result = invokeWorker(request(), process.execPath, controller.signal, 5000, [fake, "hang"]);
  19     setTimeout(() => controller.abort(), 100);
  20     await expect(result).rejects.toThrow(/canceled/);
  21   });
  22   it("real Rust worker rejects malformed, extra, oversized and unsupported request frames", () => {
  23     const native = resolve("../../target/debug/lens-snapshot" + (process.platform === "win32" ? ".exe" : ""));
  24     const frame = JSON.stringify(request());
  25     const inputs = [Buffer.from(frame), Buffer.from(`${frame}\n${frame}\n`), Buffer.alloc(8193, 120), Buffer.from([0xff, 10]), Buffer.from(`${JSON.stringify({ ...request(), protocolVersion: 2 })}\n`), Buffer.from(`${JSON.stringify({ ...request(), operation: "execute" })}\n`)];
  26     for (const input of inputs) {
  27       const result = spawnSync(native, [], { input, timeout: 3000, maxBuffer: 65536 });
  28       expect(result.status).toBe(2);
  29       expect(JSON.parse(result.stdout.toString())).toMatchObject({ protocolVersion: 1, type: "error", complete: true, retryable: false });
  30     }
  31   });
  32 });
```

## packages/lens/test/render.test.ts

Source digest: 9895c112bab33febc654609230db223727053c8eaebce4a80fa60dc11c00f89c. 26 lines. Explanation level: test-overview.

This behavior fixture supplies concrete inputs and checks only the stated contract. Read its test titles with the corresponding chapter: each expectation demonstrates a supported observation, rejected boundary or unchanged negative. Full individual statement annotations remain a recorded learning gap.

### Lines 1-26

Complete file excerpt for review alongside its responsibility above.

```
   1 import { describe, expect, it } from "vitest";
   2 import { compareFiles } from "../src/compare.js";
   3 import { display, render } from "../src/render.js";
   4 import type { Manifest } from "../src/contracts.js";
   5
   6 const manifest: Manifest = { schemaVersion: 1, comparison: { requestedBase: "b", requestedHead: "h", resolvedBase: "a".repeat(40), resolvedHead: "b".repeat(40), comparisonBase: "a".repeat(40), policy: "exact" }, before: [], after: [], diagnostics: [], totalBytes: 0 };
   7 describe("report rendering", () => {
   8   it("escapes source HTML, terminal controls, Markdown and workflow-like text", () => {
   9     const before = { path: "<script>\x1b[31m.ts", revision: "a".repeat(40), content: "export function x(a: string) { return '<script>alert(1)</script>'; }" };
  10     const report = compareFiles([before], [{ ...before, content: "export function x(a?: string) { return '<script>alert(1)</script>'; }" }], manifest);
  11     report.findings[0]!.reason = "::warning:: <img onerror=x> [link](javascript:bad)\x1b[31m";
  12     const html = render(report, "html");
  13     expect(html).not.toContain("<script>");
  14     expect(html).not.toContain("<img onerror");
  15     expect(html).toContain("&lt;script&gt;");
  16     expect(html).toContain("default-src 'none'");
  17     expect(render(report, "terminal")).not.toContain("\x1b");
  18     expect(render(report, "markdown")).toContain("\\[link\\]\\(javascript:bad\\)");
  19     expect(display("\x1b\r\n")).toBe("\\u001b\\u000d\\u000a");
  20     expect(JSON.parse(render(report, "json"))).toEqual(report);
  21   });
  22   it("produces identical deterministic reports for repeated input", () => {
  23     const file = { path: "a.ts", revision: "a".repeat(40), content: "export function a() {}" };
  24     expect(compareFiles([file], [file], manifest)).toEqual(compareFiles([file], [file], manifest));
  25   });
  26 });
```

## packages/lens/test/trusted-git.test.ts

Source digest: d0c8ca85c54f5bb1e5674a60a54fc69ccbac9247dd613b11b4dd689400c49fbd. 22 lines. Explanation level: test-overview.

This behavior fixture supplies concrete inputs and checks only the stated contract. Read its test titles with the corresponding chapter: each expectation demonstrates a supported observation, rejected boundary or unchanged negative. Full individual statement annotations remain a recorded learning gap.

### Lines 1-22

Complete file excerpt for review alongside its responsibility above.

```
   1 import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
   2 import { tmpdir } from "node:os";
   3 import { delimiter, join } from "node:path";
   4 import { describe, expect, it } from "vitest";
   5 import { resolveTrustedGit } from "../src/trusted-git.js";
   6
   7 describe("trusted Git executable discovery", () => {
   8   it("rejects target checkout, relative and other source-checkout PATH candidates", async () => {
   9     const root = await mkdtemp(join(tmpdir(), "lens-git-tool-"));
  10     try {
  11       const repo = join(root, "target");
  12       const other = join(root, "other-checkout");
  13       const tool = join(root, "tool-install");
  14       for (const directory of [repo, other, tool]) await mkdir(directory);
  15       await mkdir(join(other, ".git"));
  16       const name = process.platform === "win32" ? "git.exe" : "git";
  17       for (const directory of [repo, other, tool]) { const file = join(directory, name); await writeFile(file, "This file must never be executed by this test"); await chmod(file, 0o755); }
  18       await expect(resolveTrustedGit(repo, [".", repo, other].join(delimiter))).rejects.toThrow(/No trusted Git/);
  19       expect(await resolveTrustedGit(repo, [repo, other, tool].join(delimiter))).toBe(join(tool, name));
  20     } finally { await rm(root, { recursive: true, force: true }); }
  21   });
  22 });
```

## scripts/demo.mjs

Source digest: 9c9bc267be81592bd1603d13151ed9837664a2366cc34af41f514e42bf848146. 49 lines. Explanation level: file-overview.

The original frozen fixture becomes fixed-date local Git commits for a seeded change and legitimate refactor. The script runs the real worker/engine, checks exact expected rule sets and writes four views plus honest measured metadata. No source is downloaded, executed or publicly published.

The complete excerpt below preserves the implementation; finer statement annotations remain a recorded learning gap.

### Lines 1-49

Complete file excerpt for review alongside its responsibility above.

```
   1 import { execFile } from "node:child_process";
   2 import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
   3 import { resolve, join } from "node:path";
   4 import { promisify } from "node:util";
   5 import { cpus, release, totalmem } from "node:os";
   6 import { capture } from "../packages/lens/dist/snapshot.js";
   7 import { runAnalysis } from "../packages/lens/dist/analysis.js";
   8 import { render } from "../packages/lens/dist/render.js";
   9
  10 await mkdir("output", { recursive: true });
  11 const root = await mkdtemp(resolve("output/seeded-demo-"));
  12 const worker = resolve(`target/debug/lens-snapshot${process.platform === "win32" ? ".exe" : ""}`);
  13 const execute = promisify(execFile);
  14 const git = async (...args) => (await execute("git", ["-C", root, ...args], { env: { ...process.env, GIT_AUTHOR_DATE: "2026-11-04T00:00:00Z", GIT_COMMITTER_DATE: "2026-11-04T00:00:00Z" } })).stdout.trim();
  15 await git("init", "-b", "main");
  16 await git("config", "user.name", "Lens seeded fixture");
  17 await git("config", "user.email", "fixture@example.invalid");
  18 await git("config", "core.autocrlf", "false");
  19 await git("config", "commit.gpgsign", "false");
  20 const fixture = JSON.parse(await readFile("fixtures/lens/cases.json", "utf8"));
  21 const before = fixture.before["api.ts"];
  22 for (const [path, content] of Object.entries(fixture.before)) await writeFile(join(root, path), content);
  23 await git("add", "."); await git("commit", "-m", "Seeded baseline, not a real vulnerability");
  24 const base = await git("rev-parse", "HEAD");
  25 for (const [path, content] of Object.entries(fixture.after)) await writeFile(join(root, path), content);
  26 await git("add", "."); await git("commit", "-m", "Seeded supported review observations");
  27 const head = await git("rev-parse", "HEAD");
  28 await git("checkout", "-b", "legitimate-refactor", base);
  29 await writeFile(join(root, "api.ts"), before.replace("return id;", "return id.trim();"));
  30 await git("add", "."); await git("commit", "-m", "Legitimate body refactor with unchanged protection and API");
  31 const refactor = await git("rev-parse", "HEAD");
  32 const results = [];
  33 for (const [name, target, expected] of [["seeded", head, fixture.expected], ["refactor", refactor, fixture.refactor.expected]]) {
  34   const started = performance.now();
  35   const snapshot = await capture(root, base, target, "exact", undefined, worker);
  36   const captured = performance.now();
  37   const report = await runAnalysis({ before: snapshot.before, after: snapshot.after, manifest: snapshot.manifest, config: fixture.config });
  38   const analyzed = performance.now();
  39   const detected = report.findings.map(finding => finding.ruleId).sort();
  40   if (JSON.stringify(detected) !== JSON.stringify(expected)) throw new Error(`${name}: unexpected rule observations ${detected}`);
  41   for (const format of ["json", "html", "markdown", "terminal"]) await writeFile(`output/${name}-report.${{ json: "json", html: "html", markdown: "md", terminal: "txt" }[format]}`, render(report, format));
  42   const rendered = performance.now();
  43   results.push({ case: name, expected, detected, milliseconds: Math.round(rendered - started), stagesMs: { snapshot: Math.round(captured - started), analysis: Math.round(analyzed - captured), render: Math.round(rendered - analyzed) }, files: report.run.files, bytes: report.run.bytes, unresolvedCalls: report.run.unresolvedCalls, completeness: report.run.completeness });
  44 }
  45 const evaluation = { dataset: "frozen-original-seeded-v1", author: "Lens workspace contributors, MIT", thirdPartySource: false, humanReviewSpeedExperiment: false, cases: results, platform: `${process.platform}-${process.arch}`, node: process.version, machine: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, systemMemoryBytes: totalmem(), osRelease: release() }, peakRssBytes: process.resourceUsage().maxRSS * 1024, note: "Two synthetic cases; not public-PR precision, security effectiveness or user time savings. Timings include bounded analysis worker startup/trusted libraries and rendering. Peak RSS describes the Node process including semantic threads, not combined Rust/Git memory.", commits: { base, head, refactor }, repository: root };
  46 await writeFile("output/evaluation.json", JSON.stringify(evaluation, null, 2) + "\n");
  47 await writeFile("output/demo-config.json", JSON.stringify({ schemaVersion: 1, guards: ["requireOwner"] }, null, 2) + "\n");
  48 await writeFile("output/demo-path.txt", root + "\n");
  49 console.log(JSON.stringify(evaluation, null, 2));
```

## scripts/evaluate-public.mjs

Source digest: 916dcb987a60b0a6996125304c1825ce690a273a508c8afc5018420def4eb72d. 52 lines. Explanation level: file-overview.

The frozen manifest is read before analysis; exact already-fetched Git commits are compared with the bounded real engine. Each third-party report retains that commit's license text. Expected/detected rule lists, partial diagnostics, stage timings, machine details and zero-denominator metrics are recorded without claiming broad precision or execution coverage. The script never installs or runs target dependencies and does not fetch implicitly.

The complete excerpt below preserves the implementation; finer statement annotations remain a recorded learning gap.

### Lines 1-52

Complete file excerpt for review alongside its responsibility above.

```
   1 import { execFile } from "node:child_process";
   2 import { mkdir, readFile, writeFile } from "node:fs/promises";
   3 import { resolve, join } from "node:path";
   4 import { promisify } from "node:util";
   5 import { cpus, release, totalmem } from "node:os";
   6 import { capture } from "../packages/lens/dist/snapshot.js";
   7 import { runAnalysis } from "../packages/lens/dist/analysis.js";
   8 import { render } from "../packages/lens/dist/render.js";
   9 import { rules } from "../packages/lens/dist/contracts.js";
  10
  11 const specification = JSON.parse(await readFile("benchmarks/public-prs.json", "utf8"));
  12 const repo = resolve(process.argv[2] ?? "tmp/evaluation/hono.git");
  13 const worker = resolve(`target/debug/lens-snapshot${process.platform === "win32" ? ".exe" : ""}`);
  14 const run = promisify(execFile);
  15 const results = [];
  16 for (const entry of specification.cases) {
  17   const directory = resolve("output/public-evaluation", entry.id);
  18   await mkdir(directory, { recursive: true });
  19   const license = (await run("git", ["-C", repo, "show", `${entry.head}:LICENSE`], { timeout: 10000, maxBuffer: 65536 })).stdout;
  20   await writeFile(join(directory, "LICENSE"), license);
  21   const started = performance.now();
  22   const snapshot = await capture(repo, entry.base, entry.head, "exact", undefined, worker);
  23   const captured = performance.now();
  24   const report = await runAnalysis({ before: snapshot.before, after: snapshot.after, manifest: snapshot.manifest, config: {} });
  25   const analyzed = performance.now();
  26   const detected = report.findings.map(finding => finding.ruleId).sort();
  27   const matchesLabel = JSON.stringify(detected) === JSON.stringify([...entry.expectedRules].sort());
  28   await writeFile(join(directory, "report.json"), render(report, "json"));
  29   await writeFile(join(directory, "report.html"), render(report, "html"));
  30   const linkedEvidence = report.findings.flatMap(finding => [finding.before, finding.after]).filter(evidence => evidence.method === "typescript-ast");
  31   let correctEvidence = 0;
  32   for (const evidence of linkedEvidence) {
  33     const source = [...snapshot.before, ...snapshot.after].find(file => file.revision === evidence.revision && file.path === evidence.path);
  34     if (source && source.content.split(/\r\n|\n/)[evidence.startLine - 1]?.includes(evidence.excerpt.split(/\r\n|\n/)[0])) correctEvidence++;
  35   }
  36   results.push({ id: entry.id, url: entry.url, base: entry.base, head: entry.head, expected: entry.expectedRules, detected, matchesLabel, completeness: report.run.completeness, diagnostics: report.run.diagnostics.length, unresolvedCalls: report.run.unresolvedCalls, files: report.run.files, bytes: report.run.bytes, milliseconds: Math.round(analyzed - started), stagesMs: { snapshot: Math.round(captured - started), analysis: Math.round(analyzed - captured) }, evidenceAccuracy: { correct: correctEvidence, denominator: linkedEvidence.length, fraction: linkedEvidence.length ? correctEvidence / linkedEvidence.length : null } });
  37 }
  38 const perRule = Object.fromEntries(Object.keys(rules).map(rule => {
  39   let truePositive = 0, falsePositive = 0, falseNegative = 0;
  40   for (const entry of results) {
  41     const expected = entry.expected.filter(id => id === rule).length;
  42     const detected = entry.detected.filter(id => id === rule).length;
  43     truePositive += Math.min(expected, detected);
  44     falsePositive += Math.max(0, detected - expected);
  45     falseNegative += Math.max(0, expected - detected);
  46   }
  47   return [rule, { truePositive, falsePositive, falseNegative, precision: truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null, recall: truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : null }];
  48 }));
  49 const output = { specification: "benchmarks/public-prs.json", cases: results, perRule, falsePositivesPerPR: Object.values(perRule).reduce((sum, value) => sum + value.falsePositive, 0) / results.length, machine: { platform: `${process.platform}-${process.arch}`, node: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), osRelease: release() }, nodePeakRssBytes: process.resourceUsage().maxRSS * 1024, memoryLimitations: "Node including semantic threads only; not total Rust/Git peak memory. These source-boundary public cases have zero positive labels, so precision/recall denominators are zero/undefined.", limitations: specification.limitations };
  50 await writeFile("output/public-evaluation/summary.json", JSON.stringify(output, null, 2) + "\n");
  51 console.log(JSON.stringify(output, null, 2));
  52 if (results.some(entry => !entry.matchesLabel)) process.exitCode = 1;
```

## scripts/learning-docs/annotations.mjs

Source digest: 6274ebb5faa55dc33aeff5b15a7249d6ceb753d563186112e18c490a19670c7a. 148 lines. Explanation level: file-overview.

This handwritten teaching data maps real statement-group markers to local purpose, runtime behavior and consequences of removing the boundary. The coverage generator recomputes line ranges rather than maintaining stale numbers by hand.

The complete excerpt below preserves the implementation; finer statement annotations remain a recorded learning gap.

The handwritten annotation data is rendered as the associated files' explanations throughout this volume, rather than duplicated as enormous string listings. Its marker-resolution algorithm is explained in coverage.mjs.

## scripts/learning-docs/build.py

Source digest: 43d4d4392c73b3c12ad16744ee6fb5621e1c026b835b6811957d0ca73df6d65c. 197 lines. Explanation level: file-overview.

The isolated ReportLab builder turns the learning Markdown and generated walkthrough into numbered PDFs with a table of contents, diagram, readable wrapped code and footers; PyMuPDF renders selected pages for visual QA. Product installation imports none of these Python dependencies.

The complete excerpt below preserves the implementation; finer statement annotations remain a recorded learning gap.

### Lines 1-197

Complete file excerpt for review alongside its responsibility above.

```
   1 """Isolated, deterministic-layout learning PDF generation and page previews."""
   2 from pathlib import Path
   3 import json
   4 import re
   5 import textwrap
   6 import subprocess
   7 from xml.sax.saxutils import escape
   8
   9 import fitz
  10 from reportlab.lib import colors
  11 from reportlab.lib.enums import TA_LEFT
  12 from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
  13 from reportlab.lib.units import mm
  14 from reportlab.platypus import (
  15     BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, PageBreak,
  16     Preformatted, KeepTogether, Flowable, TableStyle,
  17 )
  18 from reportlab.platypus.tableofcontents import TableOfContents
  19
  20 ROOT = Path(__file__).resolve().parents[2]
  21 OUT = ROOT / "output/pdf"
  22 PREVIEWS = ROOT / "tmp/pdfs"
  23 OUT.mkdir(parents=True, exist_ok=True)
  24 PREVIEWS.mkdir(parents=True, exist_ok=True)
  25 styles = getSampleStyleSheet()
  26 styles.add(ParagraphStyle(name="Body", fontName="Helvetica", fontSize=10,
  27                           leading=15, spaceAfter=8, alignment=TA_LEFT,
  28                           textColor=colors.HexColor("#253247")))
  29 styles.add(ParagraphStyle(name="CodeSmall", fontName="Courier", fontSize=8.3,
  30                           leading=11.5, spaceAfter=8, backColor=colors.HexColor("#f1f5f9"),
  31                           leftIndent=6, rightIndent=6))
  32 styles["Heading1"].fontSize = 21
  33 styles["Heading1"].leading = 26
  34 styles["Heading2"].fontSize = 15
  35 styles["Heading2"].leading = 20
  36 styles["Heading3"].fontSize = 11
  37 styles["Heading3"].leading = 15
  38 for name in ["Heading1", "Heading2", "Heading3"]:
  39     styles[name].keepWithNext = True
  40
  41
  42 class Diagram(Flowable):
  43     def __init__(self):
  44         super().__init__()
  45         self.width, self.height = 165 * mm, 44 * mm
  46
  47     def draw(self):
  48         canvas = self.canv
  49         labels = [["CLI / Action", "Rust + Git", "Blob manifest"],
  50                   ["Isolated AST", "Rules + evidence", "Four report views"]]
  51         for row, names in enumerate(labels):
  52             for column, label in enumerate(names):
  53                 x, y = column * 55 * mm, (1 - row) * 23 * mm
  54                 canvas.setFillColor(colors.HexColor("#e8f0fc"))
  55                 canvas.setStrokeColor(colors.HexColor("#7894bd"))
  56                 canvas.roundRect(x, y, 49 * mm, 16 * mm, 4, fill=1)
  57                 canvas.setFillColor(colors.HexColor("#17345c"))
  58                 canvas.setFont("Helvetica-Bold", 9)
  59                 canvas.drawCentredString(x + 24.5 * mm, y + 6 * mm, label)
  60                 if column < 2:
  61                     canvas.line(x + 49 * mm, y + 8 * mm, x + 54 * mm, y + 8 * mm)
  62         canvas.setStrokeColor(colors.HexColor("#7894bd"))
  63         path = canvas.beginPath()
  64         path.moveTo(134.5 * mm, 23 * mm)
  65         path.lineTo(134.5 * mm, 19.5 * mm)
  66         path.lineTo(24.5 * mm, 19.5 * mm)
  67         path.lineTo(24.5 * mm, 16 * mm)
  68         canvas.drawPath(path)
  69
  70
  71 class Book(BaseDocTemplate):
  72     def __init__(self, path, title):
  73         super().__init__(str(path), pagesize=(210 * mm, 297 * mm),
  74                          leftMargin=20 * mm, rightMargin=20 * mm,
  75                          topMargin=20 * mm, bottomMargin=20 * mm,
  76                          title=title, author="Lens workspace contributors")
  77         self.book_title = title
  78         frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height,
  79                       leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
  80         self.addPageTemplates(PageTemplate(id="main", frames=frame, onPage=self.footer))
  81
  82     def footer(self, canvas, document):
  83         canvas.saveState()
  84         canvas.setFont("Helvetica", 8)
  85         canvas.setFillColor(colors.HexColor("#64748b"))
  86         canvas.drawString(20 * mm, 11 * mm, self.book_title)
  87         canvas.drawRightString(190 * mm, 11 * mm, str(document.page))
  88         canvas.restoreState()
  89
  90     def afterFlowable(self, flowable):
  91         levels = ["Heading1", "Heading2"] if "source walkthrough" in self.book_title else ["Heading1"]
  92         if isinstance(flowable, Paragraph) and flowable.style.name in levels:
  93             self.notify("TOCEntry", (0 if flowable.style.name == "Heading1" else 1,
  94                                      flowable.getPlainText(), self.page))
  95
  96
  97 def inline(text):
  98     # Plain, readable labels; avoid unresolved Markdown tokens in PDF body text.
  99     text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1 (\2)", text)
 100     return escape(text).replace("`", "")
 101
 102
 103 def markdown(text):
 104     result, paragraph, code = [], [], []
 105     in_code = False
 106
 107     def flush():
 108         if paragraph:
 109             result.append(Paragraph(inline(" ".join(paragraph)), styles["Body"]))
 110             paragraph.clear()
 111
 112     for line in text.splitlines():
 113         if line.startswith("```"):
 114             flush()
 115             if in_code:
 116                 wrapped = []
 117                 for source_line in code:
 118                     printable = "".join(character if ord(character) < 128 else f"\\u{ord(character):04x}" for character in source_line)
 119                     wrapped.extend(textwrap.wrap(printable.expandtabs(4), width=92,
 120                                                   replace_whitespace=False,
 121                                                   drop_whitespace=False) or [""])
 122                 # Small independent blocks permit clean page breaks in long source.
 123                 if result and isinstance(result[-1], Paragraph):
 124                     result[-1].keepWithNext = True
 125                 result.append(Preformatted("\n".join(wrapped[:8]), styles["CodeSmall"]))
 126                 for start in range(8, len(wrapped), 28):
 127                     result.append(Preformatted("\n".join(wrapped[start:start + 28]), styles["CodeSmall"]))
 128                 code.clear()
 129             in_code = not in_code
 130         elif in_code:
 131             code.append(line)
 132         elif line.startswith("#"):
 133             flush()
 134             level = min(3, len(line) - len(line.lstrip("#")))
 135             result.append(Paragraph(inline(line.lstrip("# ")), styles[f"Heading{level}"]))
 136         elif not line.strip():
 137             flush()
 138         elif line.startswith("| "):
 139             flush()
 140             if not line.startswith("| ---"):
 141                 cells = [cell.strip() for cell in line.strip("|").split("|")]
 142                 result.append(Paragraph(inline(" / ".join(cells)), styles["Body"]))
 143         elif re.match(r"^(?:- |\d+\. )", line):
 144             flush()
 145             result.append(Paragraph(inline(line), styles["Body"]))
 146         else:
 147             paragraph.append(line.strip())
 148     flush()
 149     return result
 150
 151
 152 def build(name, title, sources, diagram=False):
 153     coverage = json.loads((ROOT / "docs/learning/annotation-coverage.json").read_text())
 154     try:
 155         revision = subprocess.run(["git", "rev-parse", "--verify", "HEAD"], cwd=ROOT,
 156                                   capture_output=True, text=True, timeout=5, check=True).stdout.strip()
 157         status = subprocess.run(["git", "-c", "core.fsmonitor=false", "status", "--porcelain"],
 158                                 cwd=ROOT, capture_output=True, text=True, timeout=5, check=True).stdout
 159         context = f"Git revision: {revision}. Worktree: {'dirty' if status else 'clean'}."
 160     except (OSError, subprocess.SubprocessError):
 161         context = "Git revision/dirty state unavailable; source digest is the snapshot anchor."
 162     story = [Paragraph(title, styles["Title"]), Spacer(1, 8 * mm),
 163              Paragraph("Implemented software, evidence and honest limits", styles["Heading2"]),
 164              Paragraph("Source snapshot: " + coverage["sourceDigest"], styles["Body"]),
 165              Paragraph(inline(context), styles["Body"]),
 166              Paragraph("Local Windows verification; hosted CI and broader release gates remain open.", styles["Body"]),
 167              PageBreak(), Paragraph("Contents", styles["Title"])]
 168     toc = TableOfContents()
 169     toc.levelStyles = [ParagraphStyle(name="TOC0", fontName="Helvetica-Bold", fontSize=10, leading=15, spaceBefore=6),
 170                        ParagraphStyle(name="TOC1", fontName="Helvetica", fontSize=9, leading=13, leftIndent=12)]
 171     toc.tableStyle = TableStyle([("TOPPADDING", (0, 0), (-1, -1), 0),
 172                                 ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
 173                                 ("VALIGN", (0, 0), (-1, -1), "TOP")])
 174     story.extend([toc, PageBreak()])
 175     if diagram:
 176         story.extend([Paragraph("Implemented execution map", styles["Heading1"]),
 177                       Diagram(), Spacer(1, 6 * mm)])
 178     for index, source in enumerate(sources):
 179         if index:
 180             story.append(PageBreak())
 181         story.extend(markdown((ROOT / source).read_text(encoding="utf-8")))
 182     path = OUT / name
 183     Book(path, title).multiBuild(story)
 184     pdf = fitz.open(path)
 185     selected = sorted({0, min(2, len(pdf) - 1), len(pdf) // 2, len(pdf) - 1})
 186     for number in selected:
 187         pdf[number].get_pixmap(matrix=fitz.Matrix(1.2, 1.2)).save(PREVIEWS / f"{path.stem}-{number + 1}.png")
 188     print(json.dumps({"file": str(path), "pages": len(pdf), "previewPages": [number + 1 for number in selected]}))
 189
 190
 191 build("lens-overview.pdf", "Lens implementation learning guide", [
 192     "docs/learning/guide.md", "docs/learning/chapters/01-fixtures.md",
 193     "docs/learning/chapters/02-worker.md", "docs/learning/chapters/03-reports-and-delivery.md",
 194     "docs/learning/chapters/04-projects-and-provenance.md",
 195     "docs/learning/concept-index.md", "docs/learning/file-map.md"], diagram=True)
 196 build("lens-source-volume-1.pdf", "Lens source walkthrough - volume 1", [
 197     "docs/learning/chapters/source-walkthrough.md"])
```

## scripts/learning-docs/coverage.mjs

Source digest: 2b5ce7828ef68fe667c4c0455ffa6ab096aeac595435e43388b4a490ac42b647. 71 lines. Explanation level: file-overview.

The inventory walks handwritten project files while excluding build/dependency artifacts, resolves annotation markers to current line ranges, computes source/config digests without PDF cycles and writes or checks coverage/file-map/source-walkthrough outputs. Missing explanations remain gaps rather than green coverage.

The complete excerpt below preserves the implementation; finer statement annotations remain a recorded learning gap.

### Lines 1-71

Complete file excerpt for review alongside its responsibility above.

```
   1 import { createHash } from "node:crypto";
   2 import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
   3 import { extname, posix } from "node:path";
   4 import { annotations, overviews } from "./annotations.mjs";
   5
   6 const ignored = new Set(["node_modules", ".git", ".tools", "target", "output", "tmp", ".pnpm-store", "dist", "bin", ".agents", ".codex", ".aws"]);
   7 const derived = new Set(["docs/learning/annotation-coverage.json", "docs/learning/file-map.md", "docs/learning/chapters/source-walkthrough.md"]);
   8 const paths = [];
   9 async function walk(directory) {
  10   for (const entry of await readdir(directory, { withFileTypes: true })) {
  11     const path = directory === "." ? entry.name : posix.join(directory, entry.name);
  12     if (entry.isDirectory()) { if (!ignored.has(entry.name)) await walk(path); }
  13     else if (!derived.has(path) && !path.endsWith(".tgz") && !path.includes("/schemas/") && [".ts", ".tsx", ".js", ".mjs", ".go", ".rs", ".json", ".yaml", ".yml", ".toml", ".md", ".py", ".txt", ".lock", ""].includes(extname(path))) paths.push(path);
  14   }
  15 }
  16 await walk(".");
  17 paths.sort();
  18 const hash = text => createHash("sha256").update(text).digest("hex");
  19 const entries = [];
  20 const details = [];
  21 for (const path of paths) {
  22   const content = (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
  23   const lines = content.trimEnd().split("\n");
  24   const generated = ["Cargo.lock", "pnpm-lock.yaml"].includes(path);
  25   const teaching = path.startsWith("docs/") || extname(path) === ".md";
  26   const configuration = [".json", ".yaml", ".yml", ".toml", ".lock", ".txt", ""].includes(extname(path));
  27   const groups = annotations[path];
  28   const overview = overviews[path];
  29   const test = path.includes("/test/");
  30   const lensConfig = configuration && (path.includes("lens") || path.startsWith(".github/") || path.startsWith("scripts/learning-docs") || ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "package.json", "pnpm-lock.yaml", ".gitignore"].includes(path));
  31   const status = groups ? "statement-groups" : overview ? "file-overview" : generated ? "generated-origin" : teaching ? "learning-or-reference-source" : lensConfig ? "configuration-overview" : test && path.startsWith("packages/lens/") ? "test-overview" : "annotation-gap";
  32   const ranges = [];
  33   if (groups) {
  34     let previous = -1;
  35     for (const [marker, explanation] of groups) {
  36       const index = lines.findIndex((line, number) => number > previous && line.includes(marker));
  37       if (index < 0) throw new Error(`Stale annotation marker ${path}: ${marker}`);
  38       ranges.push({ startLine: index + 1, marker, explanation });
  39       previous = index;
  40     }
  41     for (let index = 0; index < ranges.length; index++) ranges[index].endLine = (ranges[index + 1]?.startLine ?? lines.length + 1) - 1;
  42   }
  43   const advanced = /(?:project|libraries|artifacts|analysis|trusted-git|links|io)\.(?:ts|test\.ts)$/.test(path);
  44   const entry = { path, digest: teaching ? null : hash(content), lines: lines.length, status, chapter: advanced ? "chapters/04-projects-and-provenance.md" : path.includes("snapshot") || path.endsWith(".rs") ? "chapters/02-worker.md" : path.includes("render") || path.includes("cli") || path.includes("action") || path.startsWith("scripts/") ? "chapters/03-reports-and-delivery.md" : "chapters/01-fixtures.md", ranges };
  45   entries.push(entry);
  46   if (groups || overview || test && path.startsWith("packages/lens/")) {
  47     details.push(`## ${path}\n\nSource digest: ${entry.digest}. ${lines.length} lines. Explanation level: ${status}.\n`);
  48     if (overview) details.push(`${overview}\n\n${groups ? "Statement groups below explain the local implementation." : "The complete excerpt below preserves the implementation; finer statement annotations remain a recorded learning gap."}\n`);
  49     if (path === "scripts/learning-docs/annotations.mjs") {
  50       details.push("The handwritten annotation data is rendered as the associated files' explanations throughout this volume, rather than duplicated as enormous string listings. Its marker-resolution algorithm is explained in coverage.mjs.\n");
  51       continue;
  52     }
  53     if (test && !groups && !overview) details.push("This behavior fixture supplies concrete inputs and checks only the stated contract. Read its test titles with the corresponding chapter: each expectation demonstrates a supported observation, rejected boundary or unchanged negative. Full individual statement annotations remain a recorded learning gap.\n");
  54     const sections = ranges.length ? ranges : [{ startLine: 1, endLine: lines.length, explanation: "Complete file excerpt for review alongside its responsibility above." }];
  55     for (const section of sections) {
  56       details.push(`### Lines ${section.startLine}-${section.endLine}\n\n${section.explanation}\n\n\`\`\`\n${lines.slice(section.startLine - 1, section.endLine).map((line, index) => `${String(section.startLine + index).padStart(4)}${line ? ` ${line}` : ""}`).join("\n")}\n\`\`\`\n`);
  57     }
  58   }
  59 }
  60 const sourceDigest = hash(entries.filter(entry => entry.digest).map(entry => `${entry.path}\0${entry.digest}`).join("\n"));
  61 const coverage = { schemaVersion: 1, sourceDigest, revision: null, dirtyWorktree: "Live Git revision/dirty status is captured when PDFs are built; the versioned inventory uses the source digest to avoid commit/digest cycles.", note: "Statement groups cover the main new engine/worker. File/test overviews and inherited RepoLab files remain explicit annotation gaps; inventory coverage is not complete teaching coverage. PDF output is excluded from source digests.", counts: Object.fromEntries([...new Set(entries.map(entry => entry.status))].sort().map(status => [status, entries.filter(entry => entry.status === status).length])), entries };
  62 const map = `# Handwritten file inventory\n\nSource snapshot digest: ${sourceDigest}. PDF builds capture live Git revision/dirty status separately.\n\nGenerated schema artifacts originate in contracts.ts through schema.ts; lockfiles originate in pnpm/Cargo resolution and must be regenerated with the pinned tools. Packaged worker binaries originate in cargo release + stage-package; PDFs originate in this learning build. Dependencies and generated bundles are not handwritten source.\n\n| File | Lines | Teaching coverage | Chapter |\n| --- | --- | --- | --- |\n${entries.map(entry => `| ${entry.path} | ${entry.lines} | ${entry.status} | ${entry.chapter} |`).join("\n")}\n`;
  63 const book = `# Detailed source walkthrough - volume 1\n\nImplementation source digest: ${sourceDigest}. PDF builds capture live Git revision/dirty status separately.\n\nRead concepts in the overview first. Numbered source lines are extracted from the actual files, not retyped examples. Each grouped explanation states local runtime purpose and the consequence of losing a boundary. File/test overviews are deliberately marked as incomplete statement coverage. The PDF displays non-ASCII source characters with explicit Unicode escapes for print-font compatibility; the versioned Markdown and source retain the original UTF-8 text.\n\n${details.join("\n")}\n`;
  64 const outputs = { "docs/learning/annotation-coverage.json": JSON.stringify(coverage, null, 2) + "\n", "docs/learning/file-map.md": map, "docs/learning/chapters/source-walkthrough.md": book.trimEnd() + "\n" };
  65 await mkdir("docs/learning/chapters", { recursive: true });
  66 for (const [path, content] of Object.entries(outputs)) {
  67   if (process.argv.includes("--check")) {
  68     if (await readFile(path, "utf8") !== content) throw new Error(`Stale learning output: ${path}; update explanations and regenerate`);
  69   } else await writeFile(path, content);
  70 }
  71 console.log(`Learning source snapshot ${sourceDigest.slice(0, 16)}; ${entries.length} files inventoried. Explicit gaps preserved.`);
```

## scripts/learning-docs/pdf.mjs

Source digest: 37fda1ff77570e5dc98d2a7f56bbc3f2b6828160e87b28f5ff09119e2a8621e1. 11 lines. Explanation level: file-overview.

The documented learning:pdf command selects only the separate workspace virtual environment or an explicit trusted override, checks that it exists and launches the PDF builder directly without a shell. A missing environment produces exact setup instructions instead of silently using product dependencies.

The complete excerpt below preserves the implementation; finer statement annotations remain a recorded learning gap.

### Lines 1-11

Complete file excerpt for review alongside its responsibility above.

```
   1 import { spawn } from "node:child_process";
   2 import { access } from "node:fs/promises";
   3 import { resolve } from "node:path";
   4
   5 const python = process.env.LENS_PDF_PYTHON ?? resolve(process.platform === "win32"
   6   ? ".tools/pdf/Scripts/python.exe" : ".tools/pdf/bin/python");
   7 try { await access(python); }
   8 catch { throw new Error("Create .tools/pdf with python -m venv .tools/pdf and install scripts/learning-docs/requirements.txt in that environment"); }
   9 const child = spawn(python, [resolve("scripts/learning-docs/build.py")], { stdio: "inherit", shell: false, windowsHide: true });
  10 child.once("error", error => { console.error(error.message); process.exitCode = 1; });
  11 child.once("close", code => { process.exitCode = code ?? 1; });
```

## scripts/lens.mjs

Source digest: 03c239f32f39d9e7e8e803a4fc6667446e78e7f6dfd4246b19279031ec51cc10. 3 lines. Explanation level: file-overview.

The developer launcher sets an explicit debug worker path only when none was supplied, then imports the same packaged CLI. It keeps developer convenience separate from installed binary discovery.

The complete excerpt below preserves the implementation; finer statement annotations remain a recorded learning gap.

### Lines 1-3

Complete file excerpt for review alongside its responsibility above.

```
   1 import { resolve } from "node:path";
   2 process.env.LENS_WORKER ??= resolve(`target/debug/lens-snapshot${process.platform === "win32" ? ".exe" : ""}`);
   3 await import("../packages/lens/dist/cli.js");
```

## scripts/package-smoke.mjs

Source digest: 6e13cbe89491a363eb00b8f132d643c1ec01f6d114de6cf77df03547dc9fd199. 49 lines. Explanation level: file-overview.

pnpm packs a tarball, reads the installed cache location, installs into a fresh temporary project with lifecycle scripts disabled, clears the developer override, verifies doctor and a self-owned real Git fixture, then deletes the temporary installation. It writes only the reviewable archive and factual smoke result into output.

The complete excerpt below preserves the implementation; finer statement annotations remain a recorded learning gap.

### Lines 1-49

Complete file excerpt for review alongside its responsibility above.

```
   1 import { execFile } from "node:child_process";
   2 import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
   3 import { tmpdir } from "node:os";
   4 import { join, resolve } from "node:path";
   5 import { promisify } from "node:util";
   6
   7 const run = promisify(execFile);
   8 const manager = process.env.npm_execpath;
   9 if (!manager) throw new Error("Run through pnpm run package:smoke so its executable is explicit");
  10 const javascriptManager = /\.(?:c|m)?js$/i.test(manager);
  11 const pm = (...args) => run(javascriptManager ? process.execPath : manager, javascriptManager ? [manager, ...args] : args, { timeout: 120000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  12 await mkdir("output/packages", { recursive: true });
  13 await pm("--filter", "@repolab/lens", "pack", "--pack-destination", resolve("output/packages"));
  14 const archive = resolve("output/packages/repolab-lens-0.1.0.tgz");
  15 const modules = await readFile("node_modules/.modules.yaml", "utf8");
  16 const store = modules.trimStart().startsWith("{") ? JSON.parse(modules).storeDir : modules.match(/^storeDir: (.+)$/m)?.[1]?.trim();
  17 if (!store) throw new Error("Cannot locate the verified dependency store from the installed workspace");
  18 const root = await mkdtemp(join(tmpdir(), "lens-install-"));
  19 try {
  20   await writeFile(join(root, "package.json"), JSON.stringify({ private: true, dependencies: { "@repolab/lens": `file:${archive.replaceAll("\\", "/")}` } }));
  21   await pm("--dir", root, "install", "--offline", "--ignore-scripts", "--store-dir", store, "--config.confirmModulesPurge=false");
  22   const cli = join(root, "node_modules/@repolab/lens/dist/cli.js");
  23   const env = { ...process.env };
  24   delete env.LENS_WORKER;
  25   const doctor = JSON.parse((await run(process.execPath, [cli, "doctor"], { env, timeout: 10000 })).stdout);
  26   if (!doctor.ready) throw new Error("Installed package doctor failed");
  27   const fixture = JSON.parse(await readFile("fixtures/lens/cases.json", "utf8"));
  28   const repository = join(root, "repository");
  29   await mkdir(repository);
  30   const git = async (...args) => (await run("git", ["-C", repository, ...args], { timeout: 10000 })).stdout.trim();
  31   await git("init", "-b", "main");
  32   await git("config", "user.name", "Lens package fixture");
  33   await git("config", "user.email", "fixture@example.invalid");
  34   await git("config", "commit.gpgsign", "false");
  35   for (const [path, content] of Object.entries(fixture.before)) await writeFile(join(repository, path), content);
  36   await git("add", "."); await git("commit", "-m", "before");
  37   const base = await git("rev-parse", "HEAD");
  38   for (const [path, content] of Object.entries(fixture.after)) await writeFile(join(repository, path), content);
  39   await git("add", "."); await git("commit", "-m", "after");
  40   const head = await git("rev-parse", "HEAD");
  41   const config = join(root, "config.json");
  42   await writeFile(config, JSON.stringify(fixture.config));
  43   const invocation = run(process.execPath, [cli, "review", "--repo", repository, "--base", base, "--head", head, "--policy", "exact", "--config", config, "--format", "json"], { env, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  44   const result = await invocation.catch(error => { if (error.code === 3) return error; throw error; });
  45   const report = JSON.parse(result.stdout);
  46   if (report.findings.length !== 6) throw new Error("Installed package did not analyze the seeded repository");
  47   await writeFile("output/package-smoke.json", JSON.stringify({ platform: `${process.platform}-${process.arch}`, archive, doctor, findings: report.findings.map(finding => finding.ruleId), workspaceLinks: false, lifecycleScripts: false, passed: true }, null, 2) + "\n");
  48   console.log("Fresh tarball installation passed: doctor and six-rule real Git review, no workspace links or lifecycle scripts.");
  49 } finally { await rm(root, { recursive: true, force: true }); }
```

## scripts/release-inventory.mjs

Source digest: 4ff8a1033bec4386a720a54ae830ba3ef0b961e484a93ad998a3a4ca335931d9. 45 lines. Explanation level: file-overview.

The release helper queries installed pnpm/Cargo metadata, reads declared licenses and available license texts, strips machine-specific source paths from the factual inventory, and computes the exact archive checksum. It labels the result as an inventory rather than a standardized SBOM, legal audit or publisher attestation. It writes only reviewable output artifacts and publishes nothing.

The complete excerpt below preserves the implementation; finer statement annotations remain a recorded learning gap.

### Lines 1-45

Complete file excerpt for review alongside its responsibility above.

```
   1 import { execFile } from "node:child_process";
   2 import { createHash } from "node:crypto";
   3 import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
   4 import { dirname, join } from "node:path";
   5 import { promisify } from "node:util";
   6 import { readBoundedText } from "../packages/lens/dist/io.js";
   7
   8 const execute = promisify(execFile);
   9 const manager = process.env.npm_execpath;
  10 if (!manager) throw new Error("Run with pnpm release:inventory");
  11 const javascriptManager = /\.(?:c|m)?js$/i.test(manager);
  12 const dependencyTree = JSON.parse((await execute(javascriptManager ? process.execPath : manager,
  13   [...(javascriptManager ? [manager] : []), "--filter", "@repolab/lens", "list", "--prod", "--depth", "Infinity", "--json"], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).stdout);
  14 const native = JSON.parse((await execute("cargo", ["metadata", "--locked", "--offline", "--format-version", "1"], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout);
  15 await mkdir("output/release/notices", { recursive: true });
  16 await writeFile("output/release/notices/Lens-LICENSE", await readBoundedText("LICENSE", 65536));
  17 const npm = new Map();
  18 async function recordLicense(name, version, path) {
  19   const files = [];
  20   for (const entry of await readdir(path, { withFileTypes: true })) {
  21     if (!entry.isFile() || !/^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(entry.name)) continue;
  22     const destination = `${name.replace(/[^\w.-]/g, "_")}-${version}-${entry.name}`;
  23     await writeFile(join("output/release/notices", destination), await readBoundedText(join(path, entry.name), 1024 * 1024));
  24     files.push(destination);
  25   }
  26   return files;
  27 }
  28 async function walk(dependencies) {
  29   for (const [name, entry] of Object.entries(dependencies ?? {})) {
  30     const key = `${name}@${entry.version}`;
  31     if (npm.has(key)) continue;
  32     const manifest = JSON.parse(await readBoundedText(join(entry.path, "package.json"), 1024 * 1024));
  33     npm.set(key, { name, version: entry.version, license: manifest.license ?? "not declared", origin: entry.resolved, notices: await recordLicense(name, entry.version, entry.path) });
  34     await walk(entry.dependencies);
  35   }
  36 }
  37 await walk(dependencyTree[0].dependencies);
  38 const cargo = [];
  39 for (const entry of native.packages) cargo.push({ name: entry.name, version: entry.version, license: entry.license ?? "not declared", origin: entry.source ?? "this workspace", notices: await recordLicense(entry.name, entry.version, dirname(entry.manifest_path)) });
  40 const inventory = { format: "lens-dependency-inventory-v1", isStandardSbom: false, version: "0.1.0", platform: `${process.platform}-${process.arch}`, npm: [...npm.values()].sort((a, b) => a.name.localeCompare(b.name, "en")), cargo: cargo.sort((a, b) => a.name.localeCompare(b.name, "en")), limitation: "Factual installed runtime/Cargo inventory and available license texts; not a completed legal audit or release-platform attestation." };
  41 await writeFile("output/release/dependency-inventory.json", JSON.stringify(inventory, null, 2) + "\n");
  42 const archive = "output/packages/repolab-lens-0.1.0.tgz";
  43 const checksum = createHash("sha256").update(await readFile(archive)).digest("hex");
  44 await writeFile("output/release/SHA256SUMS", `${checksum}  repolab-lens-0.1.0.tgz\n`);
  45 console.log(`Prepared ${inventory.npm.length} npm and ${inventory.cargo.length} Cargo inventory entries, license texts and archive checksum. Nothing published.`);
```

## scripts/stage-package.mjs

Source digest: b7c8f40b532ed8b018c293eeb7120f8c0ae74dafb1264143520d55b3bed4bd54. 14 lines. Explanation level: file-overview.

The developer release script copies only the current platform's release worker and license, adds exact version/protocol/digest metadata, and changes executable permissions. It neither downloads binaries nor publishes a package.

The complete excerpt below preserves the implementation; finer statement annotations remain a recorded learning gap.

### Lines 1-14

Complete file excerpt for review alongside its responsibility above.

```
   1 import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
   2 import { createHash } from "node:crypto";
   3 import { resolve } from "node:path";
   4
   5 const target = `${process.platform}-${process.arch}`;
   6 const name = `lens-snapshot${process.platform === "win32" ? ".exe" : ""}`;
   7 const directory = resolve("packages/lens/bin", target);
   8 await mkdir(directory, { recursive: true });
   9 const binary = resolve(directory, name);
  10 await copyFile(resolve("target/release", name), binary);
  11 await chmod(binary, 0o755);
  12 await copyFile("LICENSE", "packages/lens/LICENSE");
  13 await writeFile(resolve(directory, "worker.json"), JSON.stringify({ version: "0.1.0", protocolVersion: 1, target, sha256: createHash("sha256").update(await readFile(binary)).digest("hex") }, null, 2) + "\n");
  14 console.log(`Staged ${target}; only this platform is included. No binary was published.`);
```

## scripts/verify.mjs

Source digest: 2e2d80b11fbc7fbd3ed0f0bd6ac1f95aeccc0e755bc0c369e3715c6beca654d6. 30 lines. Explanation level: file-overview.

The documented local verification command runs owned build/format/Clippy/test/schema/learning gates in dependency order, launches each executable directly, and stops at the first nonzero exit. It uses the known pnpm executable and does not publish, fetch target code or turn failed checks into success.

The complete excerpt below preserves the implementation; finer statement annotations remain a recorded learning gap.

### Lines 1-30

Complete file excerpt for review alongside its responsibility above.

```
   1 import { spawn } from "node:child_process";
   2
   3 const manager = process.env.npm_execpath;
   4 if (!manager) throw new Error("Run this gate with pnpm verify");
   5 const javascriptManager = /\.(?:c|m)?js$/i.test(manager);
   6 const pm = args => [javascriptManager ? process.execPath : manager, [...(javascriptManager ? [manager] : []), ...args]];
   7 const steps = [
   8   ["cargo", ["fmt", "--all", "--", "--check"]],
   9   ["cargo", ["clippy", "--locked", "--offline", "--all-targets", "--", "-D", "warnings"]],
  10   ["cargo", ["test", "--locked", "--offline"]],
  11   ["cargo", ["build", "--locked", "--offline"]],
  12   ["cargo", ["build", "--release", "--locked", "--offline"]],
  13   [process.execPath, ["scripts/stage-package.mjs"]],
  14   pm(["build"]),
  15   [process.execPath, ["packages/lens/dist/schema.js", "--check"]],
  16   pm(["lens:demo"]),
  17   pm(["test"]),
  18   pm(["typecheck"]),
  19   pm(["format:check"]),
  20   [process.execPath, ["scripts/learning-docs/coverage.mjs", "--check"]],
  21 ];
  22 for (const [binary, args] of steps) {
  23   console.log(`Verify: ${[binary, ...args].join(" ")}`);
  24   const code = await new Promise((resolve, reject) => {
  25     const child = spawn(binary, args, { stdio: "inherit", shell: false, windowsHide: true });
  26     child.once("error", reject);
  27     child.once("close", resolve);
  28   });
  29   if (code !== 0) { process.exitCode = typeof code === "number" ? code : 1; break; }
  30 }
```
