import type { ExperienceEvent, ExperienceHit } from "./contracts.ts";

export interface ExperienceInjectionOptions {
  readonly maxItems?: number;
  readonly maxChars?: number;
  readonly minConfidence?: number;
  readonly excludeIds?: ReadonlySet<string>;
}

export interface ExperienceInjection {
  readonly items: readonly ExperienceEvent[];
  readonly text: string;
}

const HEADER = "Known experience (use only if relevant):";

export function selectExperienceForInjection(
  hits: readonly ExperienceHit[],
  options: ExperienceInjectionOptions = {},
): ExperienceInjection {
  const maxItems = options.maxItems ?? 2;
  const maxChars = options.maxChars ?? 400;
  const minConfidence = options.minConfidence ?? 0.3;
  const excludeIds = options.excludeIds ?? new Set<string>();

  const items: ExperienceEvent[] = [];
  const lines: string[] = [];

  for (const hit of hits) {
    if (items.length >= maxItems) break;
    const experience = hit.experience;
    if (experience.lifecycle !== "active") continue;
    if (experience.confidence < minConfidence) continue;
    if (excludeIds.has(experience.experienceId)) continue;

    const line = formatLine(experience);
    const candidate = [HEADER, ...lines, line].join("\n");
    if (candidate.length > maxChars) continue;

    items.push(experience);
    lines.push(line);
  }

  if (items.length === 0) return { items: [], text: "" };
  return { items, text: [HEADER, ...lines].join("\n") };
}

function formatLine(experience: ExperienceEvent): string {
  const action = experience.action ? `; action: ${experience.action}` : "";
  return `- When ${experience.situation} → ${experience.lesson}${action} (confidence ${experience.confidence.toFixed(2)})`;
}
