import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectInstall, detectSourceInstall, isOfficialSourceRemote, verifyInstall } from "../lib/install.js";

test("detects and verifies a package installation without scanning the DSH home", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "dsh-safe-install-"));
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const packageRoot = join(root, "lib", "node_modules", "@deepseek-ai", "dsh");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "1.2.3", bin: { dsh: "bin/dsh.js" } }));
  await writeFile(join(packageRoot, "bin", "dsh.js"), "");
  const launcher = join(root, "bin", "dsh");
  await mkdir(join(root, "bin"));
  await symlink(join(packageRoot, "bin", "dsh.js"), launcher);

  const detected = detectInstall(launcher);
  assert.equal(detected.supported, true);
  assert.equal(detected.kind, "npm");
  assert.equal(detected.prefix, await import("node:fs/promises").then(({ realpath }) => realpath(root)));
  assert.equal(verifyInstall(root, "1.2.3").ok, true);
});

test("refuses an npx-managed cache", () => {
  const result = detectInstall("/tmp/.npm/_npx/abc/node_modules/@deepseek-ai/dsh/bin/dsh.js");
  assert.equal(result.supported, false);
});

test("detects only a clean official source checkout", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "dsh-safe-source-install-"));
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const launcher = join(root, "apps", "cli", "src", "bin.ts");
  await mkdir(join(root, "apps", "cli", "src"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-root", version: "0.1.0" }));
  await writeFile(launcher, "");
  execFileSync("git", ["init", "--initial-branch=master", root], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.name", "Maintainer"]);
  execFileSync("git", ["-C", root, "config", "user.email", "maintainer@example.invalid"]);
  execFileSync("git", ["-C", root, "add", "package.json", "apps/cli/src/bin.ts"]);
  execFileSync("git", ["-C", root, "commit", "-m", "initial"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/deepseek-ai/deepseek-harness.git"]);

  const detected = detectSourceInstall(launcher);
  assert.equal(detected.supported, true);
  assert.equal(detected.kind, "source");
  assert.equal(detected.sourceRoot, root);
  assert.equal(detected.branch, "master");
  assert.match(detected.commit, /^[0-9a-f]{40}$/);

  await writeFile(join(root, "uncommitted.txt"), "local work");
  assert.equal(detectSourceInstall(launcher).reason, "source-worktree-dirty");
});

test("accepts only the official GitHub source remote", () => {
  assert.equal(isOfficialSourceRemote("https://github.com/deepseek-ai/deepseek-harness.git"), true);
  assert.equal(isOfficialSourceRemote("git@github.com:deepseek-ai/deepseek-harness.git"), true);
  assert.equal(isOfficialSourceRemote("https://github.com/example/deepseek-harness.git"), false);
  assert.equal(isOfficialSourceRemote("https://github.com/deepseek-ai/deepseek-harness.example.git"), false);
  assert.equal(isOfficialSourceRemote("https://git.example.invalid/deepseek-ai/deepseek-harness.git"), false);
});
