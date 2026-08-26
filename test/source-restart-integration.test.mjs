import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const helper = new URL("../scripts/apply-source-update.mjs", import.meta.url);
const fromCommit = "1".repeat(40);
const targetCommit = "2".repeat(40);

function waitFor(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
}

async function waitForFile(file) {
  for (let index = 0; index < 40; index += 1) {
    try {
      return await readFile(file, "utf8");
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return readFile(file, "utf8");
}

async function runSourceUpdate(context, { failTargetBuild = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-safe-source-restart-"));
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const data = join(root, "data");
  const sourceRoot = join(root, "source");
  const fakeBin = join(root, "bin");
  const headFile = join(root, "head.txt");
  const marker = join(root, "restarted.txt");
  await mkdir(data, { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(headFile, fromCommit);

  await writeFile(
    join(fakeBin, "git"),
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const operation = args.slice(args[0] === "-C" ? 2 : 0);
const head = () => readFileSync(process.env.HEAD_FILE, "utf8").trim();
if (operation[0] === "remote" && operation[1] === "get-url") console.log("https://github.com/deepseek-ai/deepseek-harness.git");
else if (operation[0] === "status") process.exit(0);
else if (operation[0] === "rev-parse" && operation[1] === "HEAD") console.log(head());
else if (operation[0] === "rev-parse" && operation[1] === "FETCH_HEAD") console.log(process.env.TARGET_COMMIT);
else if (operation[0] === "fetch" || operation[0] === "merge-base") process.exit(0);
else if (operation[0] === "merge" && operation[1] === "--ff-only") writeFileSync(process.env.HEAD_FILE, process.env.TARGET_COMMIT);
else if (operation[0] === "reset" && operation[1] === "--hard") writeFileSync(process.env.HEAD_FILE, operation[2]);
else process.exit(10);
`,
  );
  await writeFile(
    join(fakeBin, "pnpm"),
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const head = readFileSync(process.env.HEAD_FILE, "utf8").trim();
if (args[0] === "install") process.exit(0);
if (args[0] === "run" && args[1] === "build") {
  if (process.env.FAIL_TARGET_BUILD === "1" && head === process.env.TARGET_COMMIT) process.exit(12);
  process.exit(0);
}
if (args[0] === "dsh" && args[1] === "--version") { console.log("0.1.0"); process.exit(0); }
if (args[0] === "dsh") { writeFileSync(process.env.RESTART_MARKER, args.slice(1).join(" ")); process.exit(0); }
process.exit(11);
`,
  );
  await chmod(join(fakeBin, "git"), 0o755);
  await chmod(join(fakeBin, "pnpm"), 0o755);

  const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  context.after(() => {
    try { parent.kill("SIGKILL"); } catch {}
  });
  const token = "source-test-token";
  await writeFile(join(data, "state.json"), JSON.stringify({ helper: { armed: true, token, targetVersion: targetCommit } }));
  await writeFile(join(data, "restart.json"), JSON.stringify({ args: ["web", "--no-open"], cwd: sourceRoot }));

  const transaction = spawn(process.execPath, [
    helper.pathname,
    "--data-dir", data,
    "--source-root", sourceRoot,
    "--remote", "origin",
    "--branch", "master",
    "--pnpm", "pnpm",
    "--parent-pid", String(parent.pid),
    "--from", fromCommit,
    "--target", targetCommit,
    "--token", token,
    "--timeout", "30000",
    "--build-timeout", "60000",
    "--shutdown-timeout", "10000",
    "--terminate-parent",
    "--restart-file", join(data, "restart.json"),
  ], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      HEAD_FILE: headFile,
      TARGET_COMMIT: targetCommit,
      RESTART_MARKER: marker,
      FAIL_TARGET_BUILD: failTargetBuild ? "1" : "0",
    },
    stdio: "ignore",
  });

  assert.equal(await waitFor(transaction), 0);
  return {
    head: (await readFile(headFile, "utf8")).trim(),
    restart: await waitForFile(marker),
    state: JSON.parse(await readFile(join(data, "state.json"), "utf8")),
  };
}

test("source helper fast-forwards, builds, verifies, and restarts DSH", { skip: process.platform === "win32" }, async (context) => {
  const result = await runSourceUpdate(context);
  assert.equal(result.head, targetCommit);
  assert.equal(result.restart, "web --no-open");
  assert.equal(result.state.installedCommit, targetCommit);
  assert.equal(result.state.lastResult.phase, "done");
  assert.equal(result.state.lastResult.restart.ok, true);
});

test("source helper restores the original commit when the target build fails", { skip: process.platform === "win32" }, async (context) => {
  const result = await runSourceUpdate(context, { failTargetBuild: true });
  assert.equal(result.head, fromCommit);
  assert.equal(result.restart, "web --no-open");
  assert.equal(result.state.installedCommit, fromCommit);
  assert.equal(result.state.lastResult.phase, "rolled-back");
  assert.equal(result.state.lastResult.rollbackVerified, true);
  assert.equal(result.state.lastResult.restart.ok, true);
});
