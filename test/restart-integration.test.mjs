import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const helper = new URL("../scripts/apply-update.mjs", import.meta.url);

function waitFor(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
}

test("helper gracefully stops, updates, verifies, and restarts DSH", { skip: process.platform === "win32" }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "dsh-safe-restart-"));
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const data = join(root, "data");
  const prefix = join(root, "prefix");
  const packageRoot = join(prefix, "lib", "node_modules", "@deepseek-ai", "dsh");
  const fakeBin = join(root, "bin");
  const marker = join(root, "restarted.txt");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await mkdir(data, { recursive: true });
  await mkdir(fakeBin, { recursive: true });

  const manifest = (version) => JSON.stringify({ name: "@deepseek-ai/dsh", version, type: "module", bin: { dsh: "bin/dsh.js" } });
  await writeFile(join(packageRoot, "package.json"), manifest("1.0.0"));
  await writeFile(join(packageRoot, "bin", "dsh.js"), 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.RESTART_MARKER, process.argv.slice(2).join(" "));');
  await writeFile(
    join(fakeBin, "npm"),
    `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nconst spec = process.argv.find((v) => v.startsWith("@deepseek-ai/dsh@"));\nconst version = spec.split("@").at(-1);\nwriteFileSync(${JSON.stringify(join(packageRoot, "package.json"))}, JSON.stringify({ name: "@deepseek-ai/dsh", version, type: "module", bin: { dsh: "bin/dsh.js" } }));\n`,
  );
  await chmod(join(fakeBin, "npm"), 0o755);

  const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  context.after(() => {
    try { parent.kill("SIGKILL"); } catch {}
  });
  const token = "test-token";
  await writeFile(join(data, "state.json"), JSON.stringify({ helper: { armed: true, token, targetVersion: "1.1.0" } }));
  await writeFile(join(data, "restart.json"), JSON.stringify({ args: ["web", "--no-open"], cwd: root }));

  const transaction = spawn(process.execPath, [
    helper.pathname,
    "--data-dir", data,
    "--prefix", prefix,
    "--parent-pid", String(parent.pid),
    "--from", "1.0.0",
    "--target", "1.1.0",
    "--token", token,
    "--timeout", "30000",
    "--shutdown-timeout", "10000",
    "--terminate-parent",
    "--restart-file", join(data, "restart.json"),
  ], {
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, RESTART_MARKER: marker },
    stdio: "ignore",
  });

  assert.equal(await waitFor(transaction), 0);
  for (let index = 0; index < 40; index += 1) {
    try {
      if (await readFile(marker, "utf8")) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await readFile(marker, "utf8"), "web --no-open");
  assert.equal(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version, "1.1.0");
  const state = JSON.parse(await readFile(join(data, "state.json"), "utf8"));
  assert.equal(state.lastResult.phase, "done");
  assert.equal(state.lastResult.restart.ok, true);
});
