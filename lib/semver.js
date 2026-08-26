const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parse(value) {
  const match = VERSION.exec(String(value || "").trim());
  if (!match) return null;
  return {
    raw: match[0],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifier(left, right) {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : null;
  const rightNumber = /^\d+$/.test(right) ? Number(right) : null;
  if (leftNumber !== null && rightNumber !== null) return Math.sign(leftNumber - rightNumber);
  if (leftNumber !== null) return -1;
  if (rightNumber !== null) return 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compare(leftValue, rightValue) {
  const left = parse(leftValue);
  const right = parse(rightValue);
  if (!left || !right) throw new Error("invalid semantic version");
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return Math.sign(left[key] - right[key]);
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const size = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < size; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const result = compareIdentifier(left.prerelease[index], right.prerelease[index]);
    if (result !== 0) return result;
  }
  return 0;
}

export function isNewer(candidate, current) {
  return compare(candidate, current) > 0;
}
