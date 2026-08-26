import { Updater } from "./updater.js";

export const name = "dsh-safe-autoupdate";

export async function apply(context, config) {
  try {
    const updater = new Updater(context, config);
    updater.start();
  } catch (error) {
    try {
      context?.logger?.warn?.(`[dsh-safe-autoupdate] inactive: ${String(error?.message || error).slice(0, 300)}`);
    } catch {}
  }
}
