import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, normalize, parse as parsePath, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

const PACKAGE_NAME = "@deepseek-ai/dsh";
const SOURCE_PACKAGE_NAME = "@deepseek-ai/dsh-root";
const OFFICIAL_SOURCE = /^https:\/\/github\.com\/deepseek-ai\/deepseek-harness(?:\.git)?$|^git@github\.com:deepseek-ai\/deepseek-harness(?:\.git)?$/i;

function readManifest(directory) {
  try {
    return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function findPackageRoot(start) {
  let current = start;
  const root = parsePath(current).root;
  while (current !== root) {
    const manifest = readManifest(current);
    if (manifest?.name === PACKAGE_NAME) return current;
    current = dirname(current);
  }
  return null;
}

function prefixFromPackageRoot(packageRoot) {
  let current = packageRoot;
  const root = parsePath(current).root;
  while (current !== root) {
    if (current.endsWith(`${sep}node_modules`)) {
      const parent = dirname(current);
      return parent.endsWith(`${sep}lib`) ? dirname(parent) : parent;
    }
    current = dirname(current);
  }
  return null;
}

function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function findSourceRoot(start) {
  let current = start;
  const root = parsePath(current).root;
  while (current !== root) {
    const manifest = readManifest(current);
    if (manifest?.name === SOURCE_PACKAGE_NAME && existsSync(join(current, ".git"))) return current;
    current = dirname(current);
  }
  return null;
}

export function isOfficialSourceRemote(url) {
  return OFFICIAL_SOURCE.test(String(url || "").trim());
}

export function detectSourceInstall(argv1 = process.argv[1]) {
  if (!argv1) return { supported: false, reason: "launcher-path-unavailable" };
  const sourceRoot = findSourceRoot(dirname(resolve(argv1)));
  if (!sourceRoot) return { supported: false, reason: "not-a-source-checkout" };
  const remote = "origin";
  const remoteUrl = git(sourceRoot, ["remote", "get-url", remote]);
  if (!isOfficialSourceRemote(remoteUrl)) return { supported: false, reason: "source-remote-not-official", sourceRoot };
  const branch = git(sourceRoot, ["branch", "--show-current"]);
  if (!branch || branch.startsWith("-") || !/^[A-Za-z0-9._/-]+$/.test(branch)) {
    return { supported: false, reason: "source-branch-unavailable", sourceRoot };
  }
  const commit = git(sourceRoot, ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/i.test(commit || "")) return { supported: false, reason: "source-commit-unavailable", sourceRoot };
  const dirty = git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (dirty === null || dirty !== "") return { supported: false, reason: "source-worktree-dirty", sourceRoot, branch, commit };
  const manifest = readManifest(sourceRoot);
  return {
    supported: true,
    kind: "source",
    sourceRoot,
    branch,
    remote,
    remoteUrl,
    commit,
    version: typeof manifest?.version === "string" ? manifest.version : commit.slice(0, 12),
  };
}

export function detectInstall(argv1 = process.argv[1]) {
  if (!argv1) return { supported: false, reason: "launcher-path-unavailable" };
  let launcher = resolve(argv1);
  try {
    if (existsSync(launcher)) launcher = realpathSync(launcher);
  } catch {}
  const packageRoot = findPackageRoot(dirname(launcher));
  if (!packageRoot) return detectSourceInstall(argv1);

  const normalized = normalize(packageRoot);
  if (normalized.includes(`${sep}.npm${sep}_npx${sep}`)) {
    return { supported: false, reason: "npx-managed-install", packageRoot };
  }

  const prefix = prefixFromPackageRoot(packageRoot);
  const manifest = readManifest(packageRoot);
  if (!prefix || typeof manifest?.version !== "string") {
    const source = detectSourceInstall(argv1);
    return source.supported ? source : { supported: false, reason: "install-prefix-unavailable", packageRoot };
  }
  return { supported: true, kind: "npm", prefix, packageRoot, version: manifest.version };
}

export function verifyInstall(prefix, expectedVersion) {
  const packageRoots = [
    join(prefix, "lib", "node_modules", "@deepseek-ai", "dsh"),
    join(prefix, "node_modules", "@deepseek-ai", "dsh"),
  ];
  const packageRoot = packageRoots.find((candidate) => readManifest(candidate)?.name === PACKAGE_NAME);
  const manifest = packageRoot ? readManifest(packageRoot) : null;
  if (manifest?.name !== PACKAGE_NAME) return { ok: false, reason: "package-missing" };
  if (manifest.version !== expectedVersion) {
    return { ok: false, reason: `version-mismatch:${manifest.version || "unknown"}` };
  }
  const bin = manifest.bin?.dsh;
  if (typeof bin !== "string" || !existsSync(join(packageRoot, bin))) {
    return { ok: false, reason: "launcher-missing" };
  }
  return { ok: true, packageRoot };
}

export const DSH_PACKAGE = PACKAGE_NAME;
