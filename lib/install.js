import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, normalize, parse as parsePath, resolve, sep } from "node:path";

const PACKAGE_NAME = "@deepseek-ai/dsh";

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

export function detectInstall(argv1 = process.argv[1]) {
  if (!argv1) return { supported: false, reason: "launcher-path-unavailable" };
  let launcher = resolve(argv1);
  try {
    if (existsSync(launcher)) launcher = realpathSync(launcher);
  } catch {}
  const packageRoot = findPackageRoot(dirname(launcher));
  if (!packageRoot) return { supported: false, reason: "not-an-npm-package-install" };

  const normalized = normalize(packageRoot);
  if (normalized.includes(`${sep}.npm${sep}_npx${sep}`)) {
    return { supported: false, reason: "npx-managed-install", packageRoot };
  }

  const prefix = prefixFromPackageRoot(packageRoot);
  const manifest = readManifest(packageRoot);
  if (!prefix || typeof manifest?.version !== "string") {
    return { supported: false, reason: "install-prefix-unavailable", packageRoot };
  }
  return { supported: true, prefix, packageRoot, version: manifest.version };
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
