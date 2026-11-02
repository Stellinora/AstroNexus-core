import type {
  MaintenanceOptions,
  MaintenanceResult,
  MemoryEvent,
  MemoryLifecycle,
} from "./contracts.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_DECAY_AFTER_MS = 90 * DAY_MS;
export const DEFAULT_ARCHIVE_AFTER_MS = 180 * DAY_MS;

export interface MaintenanceAction {
  readonly memoryId: string;
  readonly to: MemoryLifecycle;
}

export interface MaintenancePlan {
  readonly actions: readonly MaintenanceAction[];
  readonly result: MaintenanceResult;
}

export function normalizeMemoryText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function planMaintenance(
  heads: readonly MemoryEvent[],
  options: MaintenanceOptions = {},
): MaintenancePlan {
  const now = options.now ?? Date.now();
  const decayAfterMs = options.decayAfterMs ?? DEFAULT_DECAY_AFTER_MS;
  const archiveAfterMs = options.archiveAfterMs ?? DEFAULT_ARCHIVE_AFTER_MS;
  const actions: MaintenanceAction[] = [];
  const decided = new Set<string>();

  const activeByText = new Map<string, MemoryEvent[]>();
  for (const event of heads) {
    if (event.lifecycle !== "active") continue;
    const key = normalizeMemoryText(event.searchText);
    if (key === "") continue;
    const group = activeByText.get(key);
    if (group) group.push(event);
    else activeByText.set(key, [event]);
  }

  let archivedDuplicates = 0;
  for (const group of activeByText.values()) {
    if (group.length < 2) continue;
    group.sort((left, right) => left.eventId - right.eventId);
    for (const duplicate of group.slice(1)) {
      actions.push({ memoryId: duplicate.memoryId, to: "archived" });
      decided.add(duplicate.memoryId);
      archivedDuplicates += 1;
    }
  }

  let decayed = 0;
  let archived = 0;
  for (const event of heads) {
    if (decided.has(event.memoryId)) continue;
    if (event.lifecycle === "active" && now - event.eventTime > decayAfterMs) {
      actions.push({ memoryId: event.memoryId, to: "decayed" });
      decided.add(event.memoryId);
      decayed += 1;
      continue;
    }
    if (event.lifecycle === "decayed" && now - event.eventTime > archiveAfterMs) {
      actions.push({ memoryId: event.memoryId, to: "archived" });
      decided.add(event.memoryId);
      archived += 1;
    }
  }

  return {
    actions,
    result: { archivedDuplicates, decayed, archived },
  };
}
