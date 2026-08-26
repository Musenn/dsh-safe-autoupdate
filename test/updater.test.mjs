import assert from "node:assert/strict";
import test from "node:test";
import { Updater } from "../lib/updater.js";

class MemoryStore {
  constructor() {
    this.directory = "/tmp/dsh-safe-autoupdate-test";
    this.data = { helper: null };
    this.logs = [];
  }

  load() {
    return this.data;
  }

  update(patch) {
    this.data = { ...this.data, ...patch };
  }

  log(level, message) {
    this.logs.push({ level, message });
  }
}

test("checks npm metadata and arms an exact update without profile operations", async () => {
  const store = new MemoryStore();
  const spawned = [];
  const updater = new Updater(
    {},
    { autoCheck: false, autoApply: true, logToConsole: false },
    {
      install: { supported: true, prefix: "/opt/dsh", version: "1.2.3" },
      store,
      run: async (command, args) => {
        assert.equal(command, "npm");
        assert.deepEqual(args, ["view", "@deepseek-ai/dsh", "dist-tags", "--json"]);
        return { ok: true, stdout: '{"latest":"1.3.0"}', stderr: "" };
      },
      spawn: (command, args, options) => {
        spawned.push({ command, args, options });
        return { unref() {} };
      },
    },
  );

  const result = await updater.check("test");
  assert.equal(result.state, "update-available");
  assert.equal(store.data.pendingVersion, "1.3.0");
  assert.equal(store.data.helper.targetVersion, "1.3.0");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].args.includes("profile"), false);
  assert.equal(spawned[0].args.includes("plugin"), false);
  assert.equal(spawned[0].options.detached, true);
});

test("does not spawn when automatic application is disabled", async () => {
  const store = new MemoryStore();
  const updater = new Updater(
    {},
    { autoCheck: false, autoApply: false, logToConsole: false },
    {
      install: { supported: true, prefix: "/opt/dsh", version: "1.2.3" },
      store,
      run: async () => ({ ok: true, stdout: '{"latest":"1.3.0"}', stderr: "" }),
      spawn: () => assert.fail("unexpected helper spawn"),
    },
  );
  const result = await updater.check("test");
  assert.equal(result.state, "update-available");
  assert.equal(store.data.helper, null);
});
