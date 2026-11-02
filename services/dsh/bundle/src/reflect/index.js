import { homedir } from "node:os";
import { join } from "node:path";

import { SqliteMemoryStore } from "../domain/memory/sqlite-store.ts";

export const name = "astronexus-reflect";

const HOUR_MS = 60 * 60 * 1000;

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  const dbPath = config.dbPath || join(home, "memory", "memory.db");
  const intervalMs = config.intervalMs ?? HOUR_MS;
  const maintenance = {
    ...(config.decayAfterMs ? { decayAfterMs: config.decayAfterMs } : {}),
    ...(config.archiveAfterMs ? { archiveAfterMs: config.archiveAfterMs } : {}),
  };

  const store = new SqliteMemoryStore(dbPath);
  let busy = false;

  const tick = () => {
    if (busy) return;
    busy = true;
    store
      .maintenance(maintenance)
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  };

  const prime = setTimeout(tick, 5000);
  if (typeof prime.unref === "function") prime.unref();

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  ctx.effect(() => () => {
    clearTimeout(prime);
    clearInterval(timer);
  });
  ctx.effect(() => () => {
    store.close().catch(() => {});
  });
}
