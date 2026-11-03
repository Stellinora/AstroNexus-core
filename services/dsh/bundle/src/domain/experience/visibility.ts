import type { ExperienceEvent } from "./contracts.ts";

export function isExperienceVisible(
  experience: Pick<ExperienceEvent, "projectId" | "visibility">,
  projectId: string | null | undefined,
): boolean {
  if (experience.visibility === "global") return true;
  if (experience.projectId === null) return true;
  return projectId != null && experience.projectId === projectId;
}
