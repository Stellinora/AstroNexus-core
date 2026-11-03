import type { MemoryKind, MemoryLifecycle } from "./contracts.ts";

export function emptyKindCounts(): Record<MemoryKind, number> {
  return { fact: 0, preference: 0, decision: 0, workflow: 0, blocker: 0, reflection: 0 };
}

export function emptyLifecycleCounts(): Record<MemoryLifecycle, number> {
  return { active: 0, decayed: 0, archived: 0, soft_deleted: 0 };
}
