import assert from "node:assert/strict";
import test from "node:test";
import { applyTransaction } from "../lib/transaction.js";

test("keeps a verified target update", async () => {
  const installed = [];
  const result = await applyTransaction({
    fromVersion: "1.0.0",
    targetVersion: "1.1.0",
    install: async (version) => (installed.push(version), { ok: true }),
    verify: async (version) => ({ ok: version === "1.1.0" }),
  });
  assert.equal(result.phase, "done");
  assert.deepEqual(installed, ["1.1.0"]);
});

test("rolls back when target verification fails", async () => {
  const installed = [];
  const result = await applyTransaction({
    fromVersion: "1.0.0",
    targetVersion: "1.1.0",
    install: async (version) => (installed.push(version), { ok: true }),
    verify: async (version) => ({ ok: version === "1.0.0", reason: "bad-target" }),
  });
  assert.equal(result.phase, "rolled-back");
  assert.equal(result.rollbackVerified, true);
  assert.deepEqual(installed, ["1.1.0", "1.0.0"]);
});
