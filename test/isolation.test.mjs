import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirectory } from "../lib/state.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("state is confined to the plugin private directory", () => {
  assert.equal(dataDirectory({ DSH_HOME: "/srv/dsh-home" }), "/srv/dsh-home/plugins-data/dsh-safe-autoupdate");
});

test("runtime source contains no credential, conversation, session, profile, push, or remote-mutation access", async () => {
  const files = [...await readdir(join(root, "lib")), "apply-update.mjs", "apply-source-update.mjs"]
    .filter((name) => name.endsWith(".js") || name.endsWith(".mjs"));
  const contents = [];
  for (const file of files) {
    const path = file.endsWith(".mjs") ? join(root, "scripts", file) : join(root, "lib", file);
    contents.push(await readFile(path, "utf8"));
  }
  const source = contents.join("\n").toLowerCase();
  for (const forbidden of [".credentials", "settings.yaml", "cordis.patch", "conversation", "sessions/", "profiles/", "git push", "git remote"]) {
    assert.equal(source.includes(forbidden), false, `forbidden runtime access: ${forbidden}`);
  }
});
