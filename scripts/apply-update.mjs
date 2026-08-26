import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DSH_PACKAGE, verifyInstall } from "../lib/install.js";
import { run } from "../lib/process.js";
import { parse } from "../lib/semver.js";
import { applyTransaction } from "../lib/transaction.js";

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const directory = value("--data-dir");
const prefix = value("--prefix");
const fromVersion = value("--from");
const targetVersion = value("--target");
const token = value("--token");
const registry = value("--registry");
const parentPid = Number(value("--parent-pid"));
const timeoutMs = Math.max(30000, Number(value("--timeout")) || 600000);
const stateFile = join(directory, "state.json");

function readState() {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

function writeState(patch) {
  const current = readState() || {};
  const temporary = `${stateFile}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, stateFile);
}

async function waitForExit(pid) {
  const deadline = Date.now() + 60 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function install(version) {
  const args = ["install", "--global", `${DSH_PACKAGE}@${version}`, "--prefix", prefix];
  if (registry) args.push("--registry", registry);
  const result = await run("npm", args, { timeoutMs });
  return { ok: result.ok, error: (result.stderr || result.stdout || "npm install failed").trim().slice(-500) };
}

if (!directory || !prefix || !parse(fromVersion) || !parse(targetVersion) || !token || !Number.isInteger(parentPid) || parentPid <= 0) process.exit(2);
if (!await waitForExit(parentPid)) process.exit(3);

const armed = readState()?.helper;
if (!armed?.armed || armed.token !== token || armed.targetVersion !== targetVersion) process.exit(0);
if (!existsSync(prefix)) process.exit(4);
if (!verifyInstall(prefix, fromVersion).ok) process.exit(5);

await new Promise((resolve) => setTimeout(resolve, 1500));

const result = await applyTransaction({
  fromVersion,
  targetVersion,
  install,
  verify: async (version) => verifyInstall(prefix, version),
});
writeState({
  installedVersion: result.phase === "done" ? targetVersion : fromVersion,
  pendingVersion: result.phase === "done" ? null : targetVersion,
  helper: null,
  lastResult: { ...result, at: Date.now() },
  lastError: result.phase === "done" ? null : result.error,
});
