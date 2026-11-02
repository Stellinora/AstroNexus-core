import { homedir } from "node:os";
import { join } from "node:path";

import { SqliteMemoryStore } from "../domain/memory/sqlite-store.ts";

export const name = "astronexus-memory";
export const inject = ["systemPrompt"];

const TEXT_BLOCK = "text";

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  const dbPath = config.dbPath || join(home, "memory", "memory.db");
  const tokenBudget = config.bootTokenBudget ?? 800;
  const maxMessageChars = config.maxMessageChars ?? 4000;

  const store = new SqliteMemoryStore(dbPath);
  let snapshot = store.boot({ tokenBudget });
  const refresh = () => {
    snapshot = store.boot({ tokenBudget });
  };

  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: "astronexus-memory",
      order: 1200,
      text: () => snapshot.text,
      required: true,
    }),
  );

  ctx.effect(() =>
    ctx.on("session/event", (session, event) => {
      try {
        if (event.type !== "user/message" && event.type !== "assistant/message") return;
        const text = extractText(event.data && event.data.message).slice(0, maxMessageChars);
        if (text === "") return;
        const kind = event.type === "user/message" ? "fact" : "reflection";
        store
          .ingest({
            kind,
            payload: { text },
            searchText: text,
            sourceRef: `${session.id}:${event.seq}`,
            externalId: `dsh:${session.id}:${event.seq}`,
          })
          .then((result) => {
            if (result.created) refresh();
          })
          .catch(() => {});
      } catch {
        // A malformed event must never break the session feed.
      }
    }),
  );

  ctx.effect(() => () => {
    store.close().catch(() => {});
  });
}

function extractText(message) {
  if (!message || !Array.isArray(message.content)) return "";
  const parts = [];
  for (const block of message.content) {
    if (block && block.type === TEXT_BLOCK && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}
