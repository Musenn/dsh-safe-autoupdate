import assert from "node:assert/strict";
import test from "node:test";
import { compare, isNewer, parse } from "../lib/semver.js";

test("semantic versions are parsed and compared", () => {
  assert.equal(parse("1.2.3")?.minor, 2);
  assert.equal(compare("1.2.3", "1.2.3-rc.1"), 1);
  assert.equal(isNewer("1.3.0", "1.2.9"), true);
  assert.equal(parse("latest"), null);
});
