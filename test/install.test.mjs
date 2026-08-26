import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectInstall, verifyInstall } from "../lib/install.js";

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
  assert.equal(detected.prefix, await import("node:fs/promises").then(({ realpath }) => realpath(root)));
  assert.equal(verifyInstall(root, "1.2.3").ok, true);
});

test("refuses an npx-managed cache", () => {
  const result = detectInstall("/tmp/.npm/_npx/abc/node_modules/@deepseek-ai/dsh/bin/dsh.js");
  assert.equal(result.supported, false);
});
