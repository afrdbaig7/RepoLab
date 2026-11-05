#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_FILE: usize = 1024 * 1024;
const MAX_FILES: usize = 4000;

#[derive(Debug, thiserror::Error)]
enum Error {
    #[error("{0}")]
    Invalid(&'static str),
    #[error("I/O operation failed: {0}")]
    Io(#[from] io::Error),
    #[error("JSON contract failed: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    protocol_version: u32,
    id: String,
    operation: String,
    repo: String,
    git: String,
    output: String,
    base: String,
    head: String,
    policy: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Comparison {
    requested_base: String,
    requested_head: String,
    resolved_base: String,
    resolved_head: String,
    comparison_base: String,
    policy: String,
}

#[derive(Serialize)]
struct File {
    path: String,
    digest: String,
    bytes: usize,
    storage: String,
}

#[derive(Serialize)]
struct Diagnostic {
    code: &'static str,
    stage: &'static str,
    message: &'static str,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    comparison: Comparison,
    before: Vec<File>,
    after: Vec<File>,
    diagnostics: Vec<Diagnostic>,
    total_bytes: usize,
}

// Drain both pipes concurrently. Each buffer and Git operation has a hard bound.
fn git(request: &Request, args: &[&str], input: Vec<u8>, limit: usize) -> Result<Vec<u8>, Error> {
    let repo = &request.repo;
    let mut command = Command::new(&request.git);
    command.env_clear();
    for key in ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args([
            "--no-pager",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-C",
            repo,
        ])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or(Error::Invalid("missing Git stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or(Error::Invalid("missing Git stderr"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or(Error::Invalid("missing Git stdin"))?;
    let output = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take((limit + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let diagnostic = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.take(65537).read_to_end(&mut bytes).map(|_| bytes)
    });
    let writer = thread::spawn(move || stdin.write_all(&input));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        if started.elapsed() > Duration::from_secs(10) {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        thread::sleep(Duration::from_millis(5));
    };
    let bytes = output
        .join()
        .map_err(|_| Error::Invalid("Git stdout reader failed"))??;
    let errors = diagnostic
        .join()
        .map_err(|_| Error::Invalid("Git stderr reader failed"))??;
    let written = writer
        .join()
        .map_err(|_| Error::Invalid("Git stdin writer failed"))?;
    if status.is_none() {
        return Err(Error::Invalid("Git operation exceeded 10 second timeout"));
    }
    if bytes.len() > limit || errors.len() > 65536 {
        return Err(Error::Invalid("Git output limit exceeded"));
    }
    if !status.is_some_and(|value| value.success()) {
        return Err(Error::Invalid(
            "Git failed; verify repository, commit refs and local history (no automatic fetch)",
        ));
    }
    written?;
    Ok(bytes)
}

fn resolve_commit(request: &Request, reference: &str) -> Result<String, Error> {
    if reference.is_empty() || reference.len() > 1000 || reference.chars().any(char::is_control) {
        return Err(Error::Invalid("invalid revision reference"));
    }
    let expression = format!("{reference}^{{commit}}");
    let result = git(
        request,
        &["rev-parse", "--verify", "--end-of-options", &expression],
        vec![],
        1024,
    )?;
    let sha = String::from_utf8(result)
        .map_err(|_| Error::Invalid("invalid commit encoding"))?
        .trim()
        .to_owned();
    if !matches!(sha.len(), 40 | 64) || !sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(Error::Invalid("invalid resolved commit"));
    }
    Ok(sha)
}

fn safe_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1000
        && !value.contains(['\\', '\0', ':'])
        && !value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        && Path::new(value)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

fn snapshot(
    request: &Request,
    sha: &str,
    total: &mut usize,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<Vec<File>, Error> {
    let tree = git(
        request,
        &["ls-tree", "--full-tree", "-r", "-z", "-l", sha],
        vec![],
        4 * MAX_FILE,
    )?;
    let mut entries: Vec<(String, String, usize)> = Vec::new();
    let mut seen = 0;
    for row in tree.split(|byte| *byte == 0).filter(|row| !row.is_empty()) {
        seen += 1;
        if seen > MAX_FILES {
            return Err(Error::Invalid("snapshot exceeds 4000 tracked entries"));
        }
        let tab = row
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or(Error::Invalid("malformed Git tree"))?;
        let metadata =
            std::str::from_utf8(&row[..tab]).map_err(|_| Error::Invalid("invalid Git metadata"))?;
        let path = std::str::from_utf8(&row[tab + 1..])
            .map_err(|_| Error::Invalid("non-UTF-8 Git paths are unsupported"))?;
        if !safe_path(path) {
            return Err(Error::Invalid("unsafe or unsupported Git path"));
        }
        let columns: Vec<&str> = metadata.split_whitespace().collect();
        if columns.len() != 4 {
            return Err(Error::Invalid("malformed Git tree metadata"));
        }
        let reason = if columns[0] == "120000" {
            Some("symlink")
        } else if columns[1] == "commit" {
            Some("submodule")
        } else if path.ends_with(".d.ts")
            || path
                .split('/')
                .any(|part| ["node_modules", "dist", "build", "vendor"].contains(&part))
        {
            Some("generated-or-vendored")
        } else if ![".ts", ".tsx", ".mts", ".cts"]
            .iter()
            .any(|suffix| path.ends_with(suffix))
            && !(path.rsplit('/').next().is_some_and(|name| {
                name == "package.json"
                    || name == "tsconfig.json"
                    || name.starts_with("tsconfig.") && name.ends_with(".json")
            }))
        {
            Some("unsupported-file")
        } else {
            None
        };
        if let Some(code) = reason {
            diagnostics.push(Diagnostic {
                code,
                stage: "snapshot",
                message: "Tracked entry excluded from TypeScript analysis.",
                path: path.to_owned(),
            });
            continue;
        }
        let bytes: usize = columns[3]
            .parse()
            .map_err(|_| Error::Invalid("invalid blob size"))?;
        if bytes > MAX_FILE {
            return Err(Error::Invalid("source file exceeds 1 MiB"));
        }
        *total = total
            .checked_add(bytes)
            .ok_or(Error::Invalid("snapshot size overflow"))?;
        if *total > MAX_BYTES {
            return Err(Error::Invalid("snapshot pair exceeds 32 MiB"));
        }
        entries.push((path.to_owned(), columns[2].to_owned(), bytes));
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let input = entries
        .iter()
        .map(|(_, oid, _)| format!("{oid}\n"))
        .collect::<String>()
        .into_bytes();
    let output = git(
        request,
        &["cat-file", "--batch"],
        input,
        MAX_BYTES + MAX_FILES * 128,
    )?;
    let mut remaining = output.as_slice();
    let mut files = Vec::new();
    for (path, oid, expected) in entries {
        let newline = remaining
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or(Error::Invalid("truncated blob header"))?;
        let header = std::str::from_utf8(&remaining[..newline])
            .map_err(|_| Error::Invalid("invalid blob header"))?;
        if header != format!("{oid} blob {expected}") {
            return Err(Error::Invalid("unexpected blob identity or size"));
        }
        remaining = &remaining[newline + 1..];
        if remaining.len() <= expected || remaining[expected] != b'\n' {
            return Err(Error::Invalid("truncated blob"));
        }
        let content = &remaining[..expected];
        remaining = &remaining[expected + 1..];
        if content.contains(&0)
            || content.starts_with(b"version https://git-lfs.github.com/spec/v1")
            || std::str::from_utf8(content).is_err()
        {
            diagnostics.push(Diagnostic {
                code: "unsupported-content",
                stage: "snapshot",
                message: "Binary, invalid UTF-8 or LFS pointer excluded.",
                path,
            });
            continue;
        }
        let digest = format!("{:x}", Sha256::digest(content));
        let storage = format!("{digest}.txt");
        let destination = Path::new(&request.output).join(&storage);
        if destination.try_exists()? {
            let metadata = fs::symlink_metadata(&destination)?;
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || fs::read(&destination)? != content
            {
                return Err(Error::Invalid("snapshot storage collision or symlink"));
            }
        } else {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)?;
            file.write_all(content)?;
        }
        files.push(File {
            path,
            digest,
            bytes: expected,
            storage,
        });
    }
    if !remaining.is_empty() {
        return Err(Error::Invalid("unexpected trailing blob data"));
    }
    Ok(files)
}

fn run(request: &Request) -> Result<Manifest, Error> {
    if request.protocol_version != 1
        || request.operation != "snapshot"
        || !["pr", "exact"].contains(&request.policy.as_str())
        || request.id.len() != 36
    {
        return Err(Error::Invalid(
            "unsupported request version, operation, policy or id",
        ));
    }
    let output = Path::new(&request.output);
    let metadata = fs::symlink_metadata(output)?;
    if !output.is_absolute()
        || metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || fs::read_dir(output)?.next().is_some()
    {
        return Err(Error::Invalid(
            "output must be an empty absolute tool-created directory",
        ));
    }
    if request.repo.len() > 4000
        || request.output.len() > 4000
        || !Path::new(&request.repo).is_absolute()
    {
        return Err(Error::Invalid(
            "repository must be an absolute path of bounded length",
        ));
    }
    let git_path = fs::canonicalize(&request.git)?;
    if request.git.len() > 4000
        || !Path::new(&request.git).is_absolute()
        || !git_path.is_file()
        || git_path.starts_with(fs::canonicalize(&request.repo)?)
    {
        return Err(Error::Invalid(
            "Git executable must be an absolute trusted path outside the target repository",
        ));
    }
    let base = resolve_commit(request, &request.base)?;
    let head = resolve_commit(request, &request.head)?;
    let comparison_base = if request.policy == "pr" {
        let bytes = git(
            request,
            &["merge-base", "--all", &base, &head],
            vec![],
            1024,
        )?;
        let value = String::from_utf8(bytes).map_err(|_| Error::Invalid("invalid merge base"))?;
        if value.lines().count() != 1 {
            return Err(Error::Invalid("multiple merge bases are ambiguous"));
        }
        resolve_commit(request, value.trim())?
    } else {
        base.clone()
    };
    let mut total = 0;
    let mut diagnostics = Vec::new();
    let before = snapshot(request, &comparison_base, &mut total, &mut diagnostics)?;
    let after = snapshot(request, &head, &mut total, &mut diagnostics)?;
    Ok(Manifest {
        schema_version: 1,
        comparison: Comparison {
            requested_base: request.base.clone(),
            requested_head: request.head.clone(),
            resolved_base: base,
            resolved_head: head,
            comparison_base,
            policy: request.policy.clone(),
        },
        before,
        after,
        diagnostics,
        total_bytes: total,
    })
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("lens-snapshot 0.1.0 protocol=1");
        return;
    }
    let mut bytes = Vec::new();
    let read = io::stdin().lock().take(8193).read_to_end(&mut bytes);
    let request = if read.is_ok()
        && bytes.len() <= 8192
        && bytes.ends_with(b"\n")
        && !bytes[..bytes.len() - 1].contains(&b'\n')
    {
        serde_json::from_slice::<Request>(&bytes)
    } else {
        serde_json::from_slice::<Request>(b"null")
    };
    let (id, result) = match request {
        Ok(request) => (request.id.clone(), run(&request)),
        Err(_) => (
            String::new(),
            Err(Error::Invalid(
                "invalid, truncated or oversized request frame",
            )),
        ),
    };
    let failed = result.is_err();
    let response = match result {
        Ok(manifest) => {
            serde_json::json!({ "protocolVersion": 1, "id": id, "type": "result", "manifest": manifest, "complete": true })
        }
        Err(error) => {
            serde_json::json!({ "protocolVersion": 1, "id": id, "type": "error", "code": "snapshot_failed", "stage": "snapshot", "message": error.to_string(), "retryable": false, "complete": true })
        }
    };
    if let Err(error) = serde_json::to_writer(io::stdout().lock(), &response).map(|_| println!()) {
        eprintln!("protocol output failed: {error}");
        std::process::exit(1);
    }
    if failed {
        std::process::exit(2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn path_boundary() {
        for path in [
            "../x.ts", "/x.ts", "C:/x.ts", "x\\y.ts", "a//b", "./x.ts", "a/../b",
        ] {
            assert!(!safe_path(path), "{path}");
        }
        for path in [
            "src/日本語.ts",
            "with space.ts",
            "-option.ts",
            "line\nbreak.ts",
        ] {
            assert!(safe_path(path), "{path}");
        }
    }
    #[test]
    fn rejects_wrong_request_shape() {
        assert!(serde_json::from_str::<Request>(r#"{"protocolVersion":1,"extra":true}"#).is_err());
    }
}
