export type Visibility = "private" | "project" | "global";

export interface ScopedVisibility {
  readonly projectId: string | null;
  readonly visibility: Visibility;
}

export function isVisible(
  scope: ScopedVisibility,
  projectId: string | null | undefined,
): boolean {
  if (scope.visibility === "global") return true;
  if (scope.projectId === null) return true;
  return projectId != null && scope.projectId === projectId;
}
