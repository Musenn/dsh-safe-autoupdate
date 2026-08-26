import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function dataDirectory(env = process.env) {
  const dshHome = env.DSH_HOME?.trim() || join(homedir(), ".dsh");
  return join(dshHome, "plugins-data", "dsh-safe-autoupdate");
}

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, "state.json");
    this.data = {
      installedVersion: null,
      pendingVersion: null,
      lastCheckAt: 0,
      lastError: null,
      helper: null,
    };
  }

  load() {
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8"));
      if (value && typeof value === "object") this.data = { ...this.data, ...value };
    } catch {}
    return this.data;
  }

  save() {
    mkdirSync(this.directory, { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.file);
  }

  update(patch) {
    this.data = { ...this.data, ...patch };
    this.save();
  }

  log(level, message) {
    mkdirSync(this.directory, { recursive: true });
    appendFileSync(join(this.directory, "autoupdate.log"), `${new Date().toISOString()} [${level}] ${message}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  writeRestartSpec(spec) {
    mkdirSync(this.directory, { recursive: true });
    const file = join(this.directory, "restart.json");
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(spec, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
    return file;
  }
}
