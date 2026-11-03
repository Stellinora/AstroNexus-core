import { randomUUID } from "node:crypto";

import { buildBootSnapshot, effectiveAccessScore } from "./boot.ts";
import { emptyKindCounts, emptyLifecycleCounts } from "./counts.ts";
import type {
  BootRequest,
  BootSnapshot,
  CorrectInput,
  CorrectResult,
  IngestInput,
  IngestResult,
  ListQuery,
  MaintenanceOptions,
  MaintenanceResult,
  MemoryEvent,
  MemoryKind,
  MemoryLifecycle,
  MemoryStats,
  MemoryStore,
  RetrieveQuery,
  RetrievalHit,
} from "./contracts.ts";
import { planMaintenance } from "./maintenance.ts";

export interface FakeStoreOptions {
  readonly now?: () => number;
}

export class FakeMemoryStore implements MemoryStore {
  readonly #events: MemoryEvent[] = [];
  readonly #access = new Map<string, { count: number; last: number }>();
  readonly #reflected = new Set<number>();
  readonly #now: () => number;
  #nextId = 1;

  constructor(options: FakeStoreOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    if (input.externalId) {
      const existing = this.#events.find((event) => event.externalId === input.externalId);
      if (existing) return { event: existing, created: false };
    }
    const event = this.#append({
      memoryId: input.memoryId ?? randomUUID(),
      supersedesId: null,
      kind: input.kind,
      payload: input.payload,
      searchText: input.searchText ?? JSON.stringify(input.payload),
      eventTime: input.eventTime ?? this.#now(),
      lifecycle: "active",
      sourceRef: input.sourceRef ?? null,
      externalId: input.externalId ?? null,
    });
    return { event, created: true };
  }

  async correct(input: CorrectInput): Promise<CorrectResult> {
    const current = this.#head(input.memoryId);
    if (!current) throw new Error(`memory not found: ${input.memoryId}`);
    const event = this.#append({
      memoryId: input.memoryId,
      supersedesId: current.eventId,
      kind: input.kind ?? current.kind,
      payload: input.payload ?? current.payload,
      searchText: input.searchText ?? current.searchText,
      eventTime: this.#now(),
      lifecycle: "active",
      sourceRef: input.sourceRef ?? current.sourceRef,
      externalId: input.externalId ?? null,
    });
    return { event, previousEventId: current.eventId };
  }

  async transition(memoryId: string, to: MemoryLifecycle): Promise<MemoryEvent> {
    const current = this.#head(memoryId);
    if (!current) throw new Error(`memory not found: ${memoryId}`);
    if (current.lifecycle === to) return current;
    return this.#append({
      memoryId,
      supersedesId: current.eventId,
      kind: current.kind,
      payload: current.payload,
      searchText: current.searchText,
      eventTime: this.#now(),
      lifecycle: to,
      sourceRef: current.sourceRef,
      externalId: null,
    });
  }

  async retrieve(query: RetrieveQuery): Promise<readonly RetrievalHit[]> {
    const needle = query.text.toLowerCase();
    const limit = query.limit ?? 10;
    const hits: RetrievalHit[] = [];
    for (const event of this.#heads()) {
      if (event.lifecycle !== "active") continue;
      if (query.kind && event.kind !== query.kind) continue;
      if (query.sourceRefPrefix && !(event.sourceRef ?? "").startsWith(query.sourceRefPrefix)) continue;
      const haystack = event.searchText.toLowerCase();
      if (needle !== "" && !haystack.includes(needle)) continue;
      const score = needle === "" ? 1 : countOccurrences(haystack, needle);
      hits.push({ event, score });
    }
    hits.sort((left, right) => right.score - left.score || right.event.eventTime - left.event.eventTime);
    const result = hits.slice(0, limit);
    for (const hit of result) this.#recordAccess(hit.event.memoryId);
    return result;
  }

  boot(request: BootRequest = {}): BootSnapshot {
    const now = this.#now();
    const scores = new Map(
      [...this.#access].map(
        ([memoryId, value]) =>
          [memoryId, effectiveAccessScore(value.count, value.last, now)] as const,
      ),
    );
    return buildBootSnapshot(this.#heads(), request, scores);
  }

  async list(query: ListQuery = {}): Promise<readonly MemoryEvent[]> {
    const lifecycles = query.lifecycles ?? ["active"];
    const limit = query.limit ?? 50;
    return this.#heads()
      .filter((event) => lifecycles.includes(event.lifecycle))
      .filter((event) => (query.kind ? event.kind === query.kind : true))
      .sort((left, right) => right.eventTime - left.eventTime)
      .slice(0, limit);
  }

  async maintenance(options: MaintenanceOptions = {}): Promise<MaintenanceResult> {
    const plan = planMaintenance(this.#heads(), options);
    for (const action of plan.actions) {
      await this.transition(action.memoryId, action.to);
    }
    return plan.result;
  }

  async recentUnreflected(limit = 50): Promise<readonly MemoryEvent[]> {
    return this.#events
      .filter((event) => !this.#reflected.has(event.eventId))
      .filter((event) => event.sourceRef !== null)
      .filter((event) => event.kind === "fact" || event.kind === "reflection")
      .slice(0, limit);
  }

  async markReflected(eventIds: readonly number[]): Promise<void> {
    for (const eventId of eventIds) this.#reflected.add(eventId);
  }

  async stats(): Promise<MemoryStats> {
    const heads = this.#heads();
    const byKind = emptyKindCounts();
    const byLifecycle = emptyLifecycleCounts();
    for (const event of heads) {
      byKind[event.kind] += 1;
      byLifecycle[event.lifecycle] += 1;
    }
    return {
      totalEvents: this.#events.length,
      active: byLifecycle.active,
      byKind,
      byLifecycle,
    };
  }

  async *exportJsonl(): AsyncIterable<string> {
    for (const event of this.#events) yield `${JSON.stringify(event)}\n`;
  }

  async close(): Promise<void> {}

  #recordAccess(memoryId: string): void {
    const current = this.#access.get(memoryId);
    this.#access.set(memoryId, {
      count: (current?.count ?? 0) + 1,
      last: this.#now(),
    });
  }

  #append(input: Omit<MemoryEvent, "eventId" | "ingestedAt">): MemoryEvent {
    const event: MemoryEvent = {
      ...input,
      eventId: this.#nextId,
      ingestedAt: this.#now(),
    };
    this.#nextId += 1;
    this.#events.push(event);
    return event;
  }

  #head(memoryId: string): MemoryEvent | undefined {
    const superseded = new Set(
      this.#events
        .filter((event) => event.supersedesId !== null)
        .map((event) => event.supersedesId as number),
    );
    let latest: MemoryEvent | undefined;
    for (const event of this.#events) {
      if (event.memoryId !== memoryId || superseded.has(event.eventId)) continue;
      if (!latest || event.eventId > latest.eventId) latest = event;
    }
    return latest;
  }

  #heads(): MemoryEvent[] {
    const superseded = new Set(
      this.#events
        .filter((event) => event.supersedesId !== null)
        .map((event) => event.supersedesId as number),
    );
    return this.#events.filter((event) => !superseded.has(event.eventId));
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
