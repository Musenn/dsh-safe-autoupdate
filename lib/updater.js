import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DSH_PACKAGE, detectInstall } from "./install.js";
import { run } from "./process.js";
import { isNewer, parse } from "./semver.js";
import { Store, dataDirectory } from "./state.js";

const HELPER = fileURLToPath(new URL("../scripts/apply-update.mjs", import.meta.url));

export const DEFAULTS = {
  enabled: true,
  autoCheck: true,
  autoApply: true,
  channel: "latest",
  startupDelayMs: 30000,
  checkIntervalMs: 6 * 60 * 60 * 1000,
  checkTimeoutMs: 30000,
  installTimeoutMs: 10 * 60 * 1000,
  registry: "",
  logToConsole: true,
};

export function normalizeConfig(input = {}) {
  const config = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (input?.[key] !== undefined) config[key] = input[key];
  }
  config.startupDelayMs = Math.max(0, Number(config.startupDelayMs) || 0);
  config.checkIntervalMs = Math.max(5 * 60 * 1000, Number(config.checkIntervalMs) || DEFAULTS.checkIntervalMs);
  config.checkTimeoutMs = Math.max(5000, Number(config.checkTimeoutMs) || DEFAULTS.checkTimeoutMs);
  config.installTimeoutMs = Math.max(30000, Number(config.installTimeoutMs) || DEFAULTS.installTimeoutMs);
  return config;
}

function extractJson(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("npm returned no dist-tag object");
  return JSON.parse(output.slice(start, end + 1));
}

export class Updater {
  constructor(context, input, options = {}) {
    this.context = context;
    this.config = normalizeConfig(input);
    this.install = options.install || detectInstall();
    this.run = options.run || run;
    this.spawn = options.spawn || spawn;
    this.store = options.store || new Store(dataDirectory());
    this.store.load();
    this.timers = new Set();
    this.checking = false;
    this.stopped = false;
  }

  write(level, message) {
    try {
      this.store.log(level, message);
    } catch {}
    if (!this.config.logToConsole) return;
    try {
      const logger = this.context?.logger;
      const method = typeof logger?.[level] === "function" ? level : "info";
      logger?.[method]?.(`[dsh-safe-autoupdate] ${message}`);
    } catch {}
  }

  start() {
    if (!this.config.enabled) return;
    if (!this.install.supported) {
      this.write("info", `inactive: ${this.install.reason}`);
      return;
    }
    this.store.update({ installedVersion: this.install.version });
    if (this.config.autoCheck) {
      this.schedule(this.config.startupDelayMs, () => this.check("startup"));
      this.schedule(this.config.checkIntervalMs, () => this.check("interval"), true);
    }
    try {
      this.context?.on?.("dispose", () => this.dispose());
    } catch {}
  }

  schedule(delay, callback, repeat = false) {
    const wrapped = () => Promise.resolve(callback()).catch((error) => this.fail(error));
    const timer = repeat ? setInterval(wrapped, delay) : setTimeout(wrapped, delay);
    timer.unref?.();
    this.timers.add(timer);
  }

  dispose() {
    this.stopped = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers.clear();
  }

  fail(error) {
    const message = String(error?.message || error).slice(0, 500);
    try {
      this.store.update({ lastError: message });
    } catch {}
    this.write("warn", message);
  }

  async check(reason = "manual") {
    if (this.stopped || this.checking || this.store.data.helper?.armed) return null;
    this.checking = true;
    try {
      const args = ["view", DSH_PACKAGE, "dist-tags", "--json"];
      if (this.config.registry) args.push("--registry", this.config.registry);
      const result = await this.run("npm", args, { timeoutMs: this.config.checkTimeoutMs });
      if (!result.ok) throw new Error(`update check failed: ${(result.stderr || result.stdout || "npm error").trim().slice(-300)}`);
      const tags = extractJson(result.stdout);
      const target = tags[this.config.channel] || tags.latest;
      if (!parse(target)) throw new Error(`invalid version from npm channel ${this.config.channel}`);
      this.store.update({ lastCheckAt: Date.now(), lastError: null });
      if (!isNewer(target, this.install.version)) {
        this.write("info", `up to date (${this.install.version}, ${reason})`);
        return { state: "up-to-date", current: this.install.version, latest: target };
      }
      this.store.update({ pendingVersion: target });
      this.write("info", `update available ${this.install.version} -> ${target}`);
      if (this.config.autoApply) this.arm(target);
      return { state: "update-available", current: this.install.version, latest: target };
    } finally {
      this.checking = false;
    }
  }

  arm(target) {
    const token = randomUUID();
    const helper = {
      armed: true,
      token,
      parentPid: process.pid,
      fromVersion: this.install.version,
      targetVersion: target,
      armedAt: Date.now(),
    };
    this.store.update({ helper });
    const args = [
      HELPER,
      "--data-dir", this.store.directory,
      "--prefix", this.install.prefix,
      "--parent-pid", String(process.pid),
      "--from", this.install.version,
      "--target", target,
      "--token", token,
      "--timeout", String(this.config.installTimeoutMs),
    ];
    if (this.config.registry) args.push("--registry", this.config.registry);
    try {
      const child = this.spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      this.write("info", `update armed for process exit (${target})`);
    } catch (error) {
      this.store.update({ helper: null });
      throw error;
    }
  }
}
