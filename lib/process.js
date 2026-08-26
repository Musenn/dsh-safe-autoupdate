import { spawn } from "node:child_process";

const OUTPUT_LIMIT = 64 * 1024;

export function run(command, args, { timeoutMs = 30000, cwd, env = process.env } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    let timer;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, code: null, stdout, stderr: String(error), timedOut: false });
      return;
    }

    child.stdout.on("data", (chunk) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += String(chunk).slice(0, OUTPUT_LIMIT - stdout.length);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += String(chunk).slice(0, OUTPUT_LIMIT - stderr.length);
    });
    child.on("error", (error) => finish({ ok: false, code: null, stdout, stderr: String(error), timedOut: false }));
    child.on("close", (code) => finish({ ok: code === 0, code, stdout, stderr, timedOut: false }));

    timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {}
      finish({ ok: false, code: null, stdout, stderr, timedOut: true });
    }, Math.max(1000, timeoutMs));
    timer.unref?.();
  });
}
