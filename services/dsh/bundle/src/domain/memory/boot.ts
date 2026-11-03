import type {
  BootItem,
  BootRequest,
  BootSnapshot,
  MemoryEvent,
  MemoryKind,
} from "./contracts.ts";
import { isVisible } from "../scope.ts";

const KIND_PRIORITY: Record<MemoryKind, number> = {
  preference: 0,
  fact: 1,
  decision: 2,
  workflow: 3,
  blocker: 4,
  reflection: 5,
};

export const DEFAULT_TOKEN_BUDGET = 800;
export const DEFAULT_MAX_ITEMS = 12;
export const ACCESS_HALF_LIFE_MS = 90 * 24 * 60 * 60 * 1000;

export function effectiveAccessScore(
  count: number,
  lastAccessedAt: number,
  now = Date.now(),
  halfLifeMs = ACCESS_HALF_LIFE_MS,
): number {
  if (count <= 0) return 0;
  const age = Math.max(0, now - lastAccessedAt);
  return count * Math.pow(0.5, age / halfLifeMs);
}

export function estimateTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const char of text) {
    if (char.codePointAt(0)! > 0x2e80) wide += 1;
    else ascii += 1;
  }
  return Math.ceil(ascii / 4 + wide);
}

export function buildBootSnapshot(
  events: readonly MemoryEvent[],
  request: BootRequest = {},
  accessScores: ReadonlyMap<string, number> = new Map(),
): BootSnapshot {
  const budget = request.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const maxItems = request.maxItems ?? DEFAULT_MAX_ITEMS;
  const kinds = request.kinds;

  const candidates = events
    .filter((event) => event.lifecycle === "active")
    .filter((event) => isVisible(event, request.projectId ?? null))
    .filter((event) => (kinds ? kinds.includes(event.kind) : true))
    .sort((left, right) => {
      const byKind = KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind];
      if (byKind !== 0) return byKind;
      const leftAccess = accessScores.get(left.memoryId) ?? 0;
      const rightAccess = accessScores.get(right.memoryId) ?? 0;
      if (leftAccess !== rightAccess) return rightAccess - leftAccess;
      return right.eventTime - left.eventTime;
    });

  const items: BootItem[] = [];
  let used = 0;
  for (const event of candidates) {
    if (items.length >= maxItems) break;
    const text = event.searchText.trim();
    if (text === "") continue;
    const cost = estimateTokens(text);
    if (items.length > 0 && used + cost > budget) break;
    used += cost;
    items.push({
      memoryId: event.memoryId,
      kind: event.kind,
      text,
      sourceRef: event.sourceRef,
    });
  }

  return {
    items,
    text: renderBootText(items),
    tokenEstimate: used,
  };
}

export function renderBootText(items: readonly BootItem[]): string {
  if (items.length === 0) return "";
  const lines = items.map((item) => `- [${item.kind}] ${item.text}`);
  return ["Known long-term memory:", ...lines].join("\n");
}
