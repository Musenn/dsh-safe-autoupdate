import { execFileSync } from "node:child_process";

let remotes = "";
try {
  remotes = execFileSync("git", ["remote", "-v"], { encoding: "utf8" });
} catch {
  process.exitCode = 1;
  throw new Error("unable to inspect Git remotes");
}

const pushTargets = remotes
  .split(/\r?\n/)
  .filter((line) => line.endsWith("(push)"))
  .map((line) => line.trim().split(/\s+/)[1]);

for (const target of pushTargets) {
  let host = "";
  try {
    host = target.startsWith("git@") ? target.slice(4).split(":")[0] : new URL(target).hostname;
  } catch {
    throw new Error(`unrecognized push remote: ${target}`);
  }
  if (host.toLowerCase() !== "github.com") throw new Error(`push remote is not GitHub: ${target}`);
}

console.log(pushTargets.length === 0 ? "No push remote configured." : "All push remotes target github.com.");
