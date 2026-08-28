import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isOfficialSourceRemote } from "../lib/install.js";
import { run } from "../lib/process.js";

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const directory = value("--data-dir");
const sourceRoot = resolve(value("--source-root") || ".");
const remote = value("--remote");
const branch = value("--branch");
const fromCommit = value("--from");
const targetCommit = value("--target");
const token = value("--token");
const pnpm = value("--pnpm") || "pnpm";
const parentPid = Number(value("--parent-pid"));
const installTimeoutMs = Math.max(30000, Number(value("--timeout")) || 600000);
const buildTimeoutMs = Math.max(60000, Number(value("--build-timeout")) || 1200000);
const shutdownTimeoutMs = Math.max(10000, Number(value("--shutdown-timeout")) || 60000);
const terminateParent = process.argv.includes("--terminate-parent");
const restartFile = value("--restart-file");
const stateFile = join(directory, "state.json");

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeState(patch) {
  const current = readJson(stateFile) || {};
  const temporary = `${stateFile}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, stateFile);
}

async function waitForExit(pid, timeout = 60 * 60 * 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  return false;
}

async function command(executable, args, timeoutMs) {
  const result = await run(executable, args, { cwd: sourceRoot, timeoutMs });
  return {
    ...result,
    detail: (result.stderr || result.stdout || `${executable} failed`).trim().slice(-1000),
  };
}

async function git(args, timeoutMs = installTimeoutMs) {
  return command("git", ["-C", sourceRoot, ...args], timeoutMs);
}

async function verifyBuild() {
  const result = await command(pnpm, ["dsh", "--version"], 60000);
  return { ok: result.ok, detail: result.detail };
}

async function prepareCommit(commit) {
  const install = await command(pnpm, ["install", "--frozen-lockfile"], installTimeoutMs);
  if (!install.ok) return { ok: false, phase: "install", error: install.detail, commit };
  const clean = await command(pnpm, ["run", "clean"], buildTimeoutMs);
  if (!clean.ok) return { ok: false, phase: "clean", error: clean.detail, commit };
  const build = await command(pnpm, ["run", "build"], buildTimeoutMs);
  if (!build.ok) return { ok: false, phase: "build", error: build.detail, commit };
  const verify = await verifyBuild();
  return verify.ok
    ? { ok: true, commit }
    : { ok: false, phase: "verify", error: verify.detail, commit };
}

async function rollback(error) {
  const reset = await git(["reset", "--hard", fromCommit]);
  if (!reset.ok) return { phase: "rollback-failed", from: fromCommit, to: targetCommit, error, rollbackError: reset.detail };
  const restored = await prepareCommit(fromCommit);
  return {
    phase: restored.ok ? "rolled-back" : "rollback-failed",
    from: fromCommit,
    to: targetCommit,
    error,
    rollbackVerified: restored.ok,
    rollbackError: restored.ok ? null : restored.error,
  };
}

function restartSource() {
  const spec = readJson(restartFile);
  if (!restartFile || !Array.isArray(spec?.args) || typeof spec.cwd !== "string") {
    return { ok: false, reason: "restart-spec-unavailable" };
  }
  try {
    const child = spawn(pnpm, ["dsh", ...spec.args.map(String)], {
      cwd: sourceRoot,
      env: process.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 300) };
  }
}

function failPreflight(error, exitCode) {
  const restart = restartSource();
  writeState({
    installedCommit: fromCommit,
    pendingVersion: targetCommit,
    helper: null,
    lastResult: {
      phase: "preflight-failed",
      from: fromCommit,
      to: targetCommit,
      error,
      restart,
      at: Date.now(),
    },
    lastError: error,
  });
  process.exit(exitCode);
}

const commitsValid = /^[0-9a-f]{40}$/i.test(fromCommit) && /^[0-9a-f]{40}$/i.test(targetCommit);
const namesValid = /^[A-Za-z0-9._/-]+$/.test(branch) && !branch.startsWith("-") && /^[A-Za-z0-9._-]+$/.test(remote);
if (!directory || !existsSync(sourceRoot) || !commitsValid || !namesValid || !token || !Number.isInteger(parentPid) || parentPid <= 0) process.exit(2);

if (terminateParent) {
  try {
    process.kill(parentPid, "SIGTERM");
  } catch {}
}
if (!await waitForExit(parentPid, terminateParent ? shutdownTimeoutMs : undefined)) process.exit(3);

const armed = readJson(stateFile)?.helper;
if (!armed?.armed || armed.token !== token || armed.targetVersion !== targetCommit) process.exit(0);

const remoteUrl = await git(["remote", "get-url", remote]);
if (!remoteUrl.ok || !isOfficialSourceRemote(remoteUrl.stdout.trim())) {
  failPreflight("source remote is not the official GitHub repository", 4);
}
const clean = await git(["status", "--porcelain=v1", "--untracked-files=normal"]);
const current = await git(["rev-parse", "HEAD"]);
if (!clean.ok || clean.stdout.trim() !== "" || !current.ok || current.stdout.trim() !== fromCommit) {
  failPreflight("source checkout changed after the update was armed", 5);
}

const fetched = await git(["fetch", "--quiet", "--no-tags", remote, branch]);
const fetchedHead = fetched.ok ? await git(["rev-parse", "FETCH_HEAD"]) : { ok: false, stdout: "" };
if (!fetched.ok) failPreflight(`source fetch failed: ${fetched.detail}`, 6);
if (!fetchedHead.ok) failPreflight(`source fetch verification failed: ${fetchedHead.detail || "FETCH_HEAD unavailable"}`, 6);
const fetchedCommit = fetchedHead.stdout.trim();
const fromIsAncestor = await git(["merge-base", "--is-ancestor", fromCommit, targetCommit]);
const targetIsUpstream = await git(["merge-base", "--is-ancestor", targetCommit, fetchedCommit]);
if (!fromIsAncestor.ok || !targetIsUpstream.ok) {
  failPreflight("locked source target is no longer a fast-forward commit on the upstream branch", 6);
}

const merged = await git(["merge", "--ff-only", targetCommit]);
let result;
if (!merged.ok) {
  result = { phase: "failed", from: fromCommit, to: targetCommit, error: merged.detail };
} else {
  const prepared = await prepareCommit(targetCommit);
  result = prepared.ok
    ? { phase: "done", from: fromCommit, to: targetCommit }
    : await rollback(`${prepared.phase}: ${prepared.error}`);
}

const runningCommit = result.phase === "done" ? targetCommit : fromCommit;
const canRestart = result.phase === "done" || result.phase === "failed" || result.rollbackVerified === true;
const restart = restartFile && canRestart ? restartSource() : null;
writeState({
  installedCommit: runningCommit,
  pendingVersion: result.phase === "done" ? null : targetCommit,
  helper: null,
  lastResult: { ...result, restart, at: Date.now() },
  lastError: result.phase === "done" ? null : result.error,
});
