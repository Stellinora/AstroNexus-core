import { randomUUID } from "node:crypto";

import { computeConfidence } from "./confidence.ts";
import { isExperienceVisible } from "./visibility.ts";
import type {
  ExperienceDraft,
  ExperienceEvent,
  ExperienceFeedbackInput,
  ExperienceFeedbackResult,
  ExperienceHit,
  ExperienceLifecycle,
  ExperienceListQuery,
  ExperienceMaintenanceOptions,
  ExperienceMaintenanceResult,
  ExperienceSearchQuery,
  ExperienceStore,
  ExperienceVisibility,
} from "./contracts.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

interface StoredExperience {
  eventId: number;
  experienceId: string;
  supersedesId: number | null;
  situation: string;
  action: string;
  outcome: string;
  lesson: string;
  conditions: string[];
  tags: string[];
  baseConfidence: number;
  lifecycle: ExperienceLifecycle;
  projectId: string | null;
  visibility: ExperienceVisibility;
  sourceRefs: string[];
  eventTime: number;
  ingestedAt: number;
  externalId: string | null;
}

export interface FakeExperienceStoreOptions {
  readonly now?: () => number;
}

export class FakeExperienceStore implements ExperienceStore {
  readonly #events: StoredExperience[] = [];
  readonly #feedback = new Map<string, { success: number; failure: number }>();
  readonly #now: () => number;
  #nextId = 1;

  constructor(options: FakeExperienceStoreOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  async remember(
    draft: ExperienceDraft,
  ): Promise<{ experience: ExperienceEvent; created: boolean }> {
    if (draft.externalId) {
      const existing = this.#events.find((event) => event.externalId === draft.externalId);
      if (existing) return { experience: this.#view(existing), created: false };
    }
    const experienceId = draft.experienceId ?? randomUUID();
    let supersedesId: number | null = null;
    if (draft.experienceId) {
      const head = this.#head(draft.experienceId);
      if (!head) throw new Error(`experience not found: ${draft.experienceId}`);
      supersedesId = head.eventId;
    }
    const event = this.#append({
      experienceId,
      supersedesId,
      situation: draft.situation.trim(),
      action: (draft.action ?? "").trim(),
      outcome: (draft.outcome ?? "").trim(),
      lesson: draft.lesson.trim(),
      conditions: normalizeList(draft.conditions),
      tags: normalizeList(draft.tags),
      baseConfidence: clamp(draft.baseConfidence ?? 0.6),
      lifecycle: "active",
      projectId: draft.projectId ?? null,
      visibility: draft.visibility ?? "private",
      sourceRefs: [...(draft.sourceRefs ?? [])],
      eventTime: draft.eventTime ?? this.#now(),
      externalId: draft.externalId ?? null,
    });
    return { experience: this.#view(event), created: true };
  }

  async search(query: ExperienceSearchQuery): Promise<readonly ExperienceHit[]> {
    return this.#search(query);
  }

  searchSync(query: ExperienceSearchQuery): readonly ExperienceHit[] {
    return this.#search(query);
  }

  #search(query: ExperienceSearchQuery): readonly ExperienceHit[] {
    const needle = query.situation.trim().toLowerCase();
    const tags = normalizeList(query.tags);
    const limit = query.limit ?? 10;
    const hits: ExperienceHit[] = [];
    for (const event of this.#heads()) {
      if (!query.includeDeprecated && event.lifecycle !== "active") continue;
      if (!isExperienceVisible(event, query.projectId ?? null)) continue;
      if (!tags.every((tag) => event.tags.includes(tag))) continue;
      const haystack = `${event.situation}\n${event.lesson}\n${event.tags.join(" ")}`.toLowerCase();
      const matchScore = looseMatchScore(haystack, needle);
      if (needle !== "" && matchScore === 0) continue;
      const view = this.#view(event);
      const tagScore = tags.length === 0 ? 0 : tags.length / Math.max(1, event.tags.length);
      hits.push({
        experience: view,
        score: (needle === "" ? 1 : matchScore) + tagScore + view.confidence,
      });
    }
    hits.sort((left, right) => right.score - left.score);
    return hits.slice(0, limit);
  }

  async list(query: ExperienceListQuery = {}): Promise<readonly ExperienceEvent[]> {
    const lifecycles = query.lifecycle ?? ["active"];
    const tags = normalizeList(query.tags);
    const limit = query.limit ?? 50;
    return this.#heads()
      .filter((event) => lifecycles.includes(event.lifecycle))
      .filter((event) => isExperienceVisible(event, query.projectId ?? null))
      .filter((event) => tags.every((tag) => event.tags.includes(tag)))
      .sort((left, right) => right.eventTime - left.eventTime)
      .slice(0, limit)
      .map((event) => this.#view(event));
  }

  async feedback(input: ExperienceFeedbackInput): Promise<ExperienceFeedbackResult> {
    const head = this.#head(input.experienceId);
    if (!head) throw new Error(`experience not found: ${input.experienceId}`);
    const current = this.#feedback.get(input.experienceId) ?? { success: 0, failure: 0 };
    if (input.success) current.success += 1;
    else current.failure += 1;
    this.#feedback.set(input.experienceId, current);
    const confidence = computeConfidence(head.baseConfidence, current.success, current.failure);
    return {
      experienceId: input.experienceId,
      successCount: current.success,
      failureCount: current.failure,
      confidence,
      lifecycle: head.lifecycle,
    };
  }

  async transition(experienceId: string, to: ExperienceLifecycle): Promise<ExperienceEvent> {
    const head = this.#head(experienceId);
    if (!head) throw new Error(`experience not found: ${experienceId}`);
    if (head.lifecycle === to) return this.#view(head);
    const event = this.#append({ ...head, supersedesId: head.eventId, lifecycle: to });
    return this.#view(event);
  }

  async maintenance(
    options: ExperienceMaintenanceOptions = {},
  ): Promise<ExperienceMaintenanceResult> {
    const now = options.now ?? this.#now();
    const minFeedback = options.minFeedback ?? 5;
    const minConfidence = options.minConfidence ?? 0.3;
    const archiveAfterMs = options.archiveAfterMs ?? 180 * DAY_MS;
    let deprecated = 0;
    let archived = 0;

    for (const head of this.#heads()) {
      const counts = this.#feedback.get(head.experienceId) ?? { success: 0, failure: 0 };
      const total = counts.success + counts.failure;
      const confidence = computeConfidence(head.baseConfidence, counts.success, counts.failure);
      if (head.lifecycle === "active" && total >= minFeedback && confidence < minConfidence) {
        await this.transition(head.experienceId, "deprecated");
        deprecated += 1;
        continue;
      }
      if (head.lifecycle === "deprecated" && now - head.eventTime > archiveAfterMs) {
        await this.transition(head.experienceId, "archived");
        archived += 1;
      }
    }
    return { deprecated, archived };
  }

  async close(): Promise<void> {}

  #view(event: StoredExperience): ExperienceEvent {
    const counts = this.#feedback.get(event.experienceId) ?? { success: 0, failure: 0 };
    return {
      ...event,
      confidence: computeConfidence(event.baseConfidence, counts.success, counts.failure),
      successCount: counts.success,
      failureCount: counts.failure,
    };
  }

  #append(input: Omit<StoredExperience, "eventId" | "ingestedAt">): StoredExperience {
    const event: StoredExperience = {
      ...input,
      eventId: this.#nextId,
      ingestedAt: this.#now(),
    };
    this.#nextId += 1;
    this.#events.push(event);
    return event;
  }

  #head(experienceId: string): StoredExperience | undefined {
    const superseded = new Set(
      this.#events
        .filter((event) => event.supersedesId !== null)
        .map((event) => event.supersedesId as number),
    );
    let latest: StoredExperience | undefined;
    for (const event of this.#events) {
      if (event.experienceId !== experienceId || superseded.has(event.eventId)) continue;
      if (!latest || event.eventId > latest.eventId) latest = event;
    }
    return latest;
  }

  #heads(): StoredExperience[] {
    const superseded = new Set(
      this.#events
        .filter((event) => event.supersedesId !== null)
        .map((event) => event.supersedesId as number),
    );
    return this.#events.filter((event) => !superseded.has(event.eventId));
  }
}

function normalizeList(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
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

function normalizeSearchText(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, "");
}

function looseMatchScore(haystack: string, needle: string): number {
  if (haystack.includes(needle)) return countOccurrences(haystack, needle);
  const normalized = normalizeSearchText(needle);
  if (normalized.length <= 6) return 0;
  let score = 0;
  for (let index = 0; index + 3 <= normalized.length; index += 1) {
    if (haystack.includes(normalized.slice(index, index + 3))) score += 1;
  }
  return score;
}
