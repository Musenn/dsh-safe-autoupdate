import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DSH_PACKAGE, detectInstall } from "./install.js";
import { run } from "./process.js";
import { isNewer, parse } from "./semver.js";
import { Store, dataDirectory } from "./state.js";

const NPM_HELPER = fileURLToPath(new URL("../scripts/apply-update.mjs", import.meta.url));
const SOURCE_HELPER = fileURLToPath(new URL("../scripts/apply-source-update.mjs", import.meta.url));

export const DEFAULTS = {
  enabled: true,
  autoCheck: true,
  autoApply: true,
  autoRestart: true,
  channel: "latest",
  startupDelayMs: 30000,
  checkIntervalMs: 6 * 60 * 60 * 1000,
  checkTimeoutMs: 30000,
  installTimeoutMs: 10 * 60 * 1000,
  restartDelayMs: 2 * 60 * 1000,
  shutdownTimeoutMs: 60 * 1000,
  sourcePnpmCommand: "pnpm",
  sourceBuildTimeoutMs: 20 * 60 * 1000,
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
  config.restartDelayMs = Math.max(0, Number(config.restartDelayMs) || 0);
  config.shutdownTimeoutMs = Math.max(10000, Number(config.shutdownTimeoutMs) || DEFAULTS.shutdownTimeoutMs);
  config.sourceBuildTimeoutMs = Math.max(60000, Number(config.sourceBuildTimeoutMs) || DEFAULTS.sourceBuildTimeoutMs);
  return config;
}

export function restartSpec(argv = process.argv.slice(2), cwd = process.cwd()) {
  const args = argv.map(String);
  const sensitive = /(?:api[-_]?key|token|secret|password|credential)/i;
  if (args.some((argument) => sensitive.test(argument) || /https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(argument))) return null;
  return { args, cwd };
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
    this.busyAgents = new Set();
    this.restartTimer = null;
    this.restartTarget = null;
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
    this.store.update({ installedVersion: this.install.version, installedCommit: this.install.commit || null });
    this.observeActivity();
    if (this.config.autoCheck) {
      this.schedule(this.config.startupDelayMs, () => this.check("startup"));
      this.schedule(this.config.checkIntervalMs, () => this.check("interval"), true);
    }
    try {
      this.context?.on?.("dispose", () => this.dispose());
    } catch {}
  }

  observeActivity() {
    try {
      this.context?.on?.("agent/status", ({ agent, status }) => {
        if (!agent) return;
        if (status === "idle") this.busyAgents.delete(agent);
        else this.busyAgents.add(agent);
        if (this.busyAgents.size > 0) this.cancelRestartTimer();
        else if (this.restartTarget) this.scheduleRestart(this.restartTarget);
      });
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
    this.cancelRestartTimer();
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
      if (this.install.kind === "source") return await this.checkSource(reason);
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
      if (this.config.autoApply) {
        if (this.config.autoRestart) this.scheduleRestart(target);
        else this.arm(target, { terminateParent: false, restart: false });
      }
      return { state: "update-available", current: this.install.version, latest: target };
    } finally {
      this.checking = false;
    }
  }

  async checkSource(reason) {
    const source = this.install;
    const status = await this.run("git", ["-C", source.sourceRoot, "status", "--porcelain=v1", "--untracked-files=normal"], {
      timeoutMs: this.config.checkTimeoutMs,
    });
    if (!status.ok || status.stdout.trim() !== "") throw new Error("source update refused: worktree is not clean");
    const fetched = await this.run("git", ["-C", source.sourceRoot, "fetch", "--quiet", "--no-tags", source.remote, source.branch], {
      timeoutMs: this.config.checkTimeoutMs,
    });
    if (!fetched.ok) throw new Error(`source update check failed: ${(fetched.stderr || fetched.stdout || "git fetch failed").trim().slice(-300)}`);
    const resolved = await this.run("git", ["-C", source.sourceRoot, "rev-parse", "FETCH_HEAD"], {
      timeoutMs: this.config.checkTimeoutMs,
    });
    const target = resolved.stdout.trim();
    if (!resolved.ok || !/^[0-9a-f]{40}$/i.test(target)) throw new Error("source update check returned an invalid commit");
    const current = await this.run("git", ["-C", source.sourceRoot, "rev-parse", "HEAD"], {
      timeoutMs: this.config.checkTimeoutMs,
    });
    const currentCommit = current.stdout.trim();
    if (!current.ok || !/^[0-9a-f]{40}$/i.test(currentCommit)) throw new Error("source checkout commit is unavailable");
    this.install.commit = currentCommit;
    this.store.update({ lastCheckAt: Date.now(), lastError: null, installedCommit: currentCommit });
    if (target === currentCommit) {
      this.write("info", `source checkout up to date (${currentCommit.slice(0, 12)}, ${reason})`);
      return { state: "up-to-date", current: currentCommit, latest: target };
    }
    const ancestor = await this.run("git", ["-C", source.sourceRoot, "merge-base", "--is-ancestor", currentCommit, target], {
      timeoutMs: this.config.checkTimeoutMs,
    });
    if (!ancestor.ok) throw new Error("source update refused: upstream is not a fast-forward descendant");
    this.store.update({ pendingVersion: target });
    this.write("info", `source update available ${currentCommit.slice(0, 12)} -> ${target.slice(0, 12)}`);
    if (this.config.autoApply) {
      if (this.config.autoRestart) this.scheduleRestart(target);
      else this.arm(target, { terminateParent: false, restart: false });
    }
    return { state: "update-available", current: currentCommit, latest: target };
  }

  cancelRestartTimer() {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.timers.delete(this.restartTimer);
    this.restartTimer = null;
  }

  scheduleRestart(target) {
    this.restartTarget = target;
    if (this.busyAgents.size > 0 || this.restartTimer) {
      this.write("info", `automatic restart deferred (${this.busyAgents.size} active agent${this.busyAgents.size === 1 ? "" : "s"})`);
      return;
    }
    this.restartTimer = setTimeout(() => {
      const timer = this.restartTimer;
      this.restartTimer = null;
      this.timers.delete(timer);
      if (this.stopped || this.busyAgents.size > 0 || this.store.data.helper?.armed) return;
      const spec = restartSpec();
      if (!spec) {
        this.write("warn", "automatic restart disabled because launcher arguments may contain sensitive data; update will wait for a natural exit");
        this.arm(target, { terminateParent: false, restart: false });
        return;
      }
      let restartFile;
      try {
        restartFile = this.store.writeRestartSpec(spec);
      } catch (error) {
        this.fail(error);
        this.arm(target, { terminateParent: false, restart: false });
        return;
      }
      try {
        this.arm(target, { terminateParent: true, restart: true, restartFile });
        this.restartTarget = null;
      } catch (error) {
        this.fail(error);
      }
    }, this.config.restartDelayMs);
    this.restartTimer.unref?.();
    this.timers.add(this.restartTimer);
    this.write("info", `automatic restart scheduled in ${this.config.restartDelayMs} ms`);
  }

  arm(target, { terminateParent = false, restart = false, restartFile = "" } = {}) {
    const token = randomUUID();
    const helper = {
      armed: true,
      token,
      parentPid: process.pid,
      fromVersion: this.install.kind === "source" ? this.install.commit : this.install.version,
      targetVersion: target,
      armedAt: Date.now(),
    };
    this.store.update({ helper });
    const isSource = this.install.kind === "source";
    const helperPath = isSource ? SOURCE_HELPER : NPM_HELPER;
    const args = [
      helperPath,
      "--data-dir", this.store.directory,
      "--parent-pid", String(process.pid),
      "--from", isSource ? this.install.commit : this.install.version,
      "--target", target,
      "--token", token,
      "--timeout", String(this.config.installTimeoutMs),
      "--shutdown-timeout", String(this.config.shutdownTimeoutMs),
    ];
    if (isSource) {
      args.push(
        "--source-root", this.install.sourceRoot,
        "--remote", this.install.remote,
        "--branch", this.install.branch,
        "--pnpm", this.config.sourcePnpmCommand,
        "--build-timeout", String(this.config.sourceBuildTimeoutMs),
      );
    } else {
      args.push("--prefix", this.install.prefix);
      if (this.config.registry) args.push("--registry", this.config.registry);
    }
    if (terminateParent) args.push("--terminate-parent");
    if (restart && restartFile) args.push("--restart-file", restartFile);
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
