export type ExperienceLifecycle = "active" | "deprecated" | "archived";
export type ExperienceVisibility = "private" | "project" | "global";

export interface ExperienceEvent {
  readonly eventId: number;
  readonly experienceId: string;
  readonly supersedesId: number | null;
  readonly situation: string;
  readonly action: string;
  readonly outcome: string;
  readonly lesson: string;
  readonly conditions: readonly string[];
  readonly tags: readonly string[];
  readonly baseConfidence: number;
  readonly confidence: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly lifecycle: ExperienceLifecycle;
  readonly projectId: string | null;
  readonly visibility: ExperienceVisibility;
  readonly sourceRefs: readonly string[];
  readonly eventTime: number;
  readonly ingestedAt: number;
  readonly externalId: string | null;
}

export interface ExperienceDraft {
  readonly experienceId?: string;
  readonly situation: string;
  readonly action?: string;
  readonly outcome?: string;
  readonly lesson: string;
  readonly conditions?: readonly string[];
  readonly tags?: readonly string[];
  readonly baseConfidence?: number;
  readonly projectId?: string | null;
  readonly visibility?: ExperienceVisibility;
  readonly sourceRefs?: readonly string[];
  readonly eventTime?: number;
  readonly externalId?: string | null;
}

export interface ExperienceSearchQuery {
  readonly situation: string;
  readonly tags?: readonly string[];
  readonly projectId?: string | null;
  readonly includeDeprecated?: boolean;
  readonly limit?: number;
}

export interface ExperienceHit {
  readonly experience: ExperienceEvent;
  readonly score: number;
}

export interface ExperienceListQuery {
  readonly lifecycle?: readonly ExperienceLifecycle[];
  readonly tags?: readonly string[];
  readonly projectId?: string | null;
  readonly limit?: number;
}

export interface ExperienceFeedbackInput {
  readonly experienceId: string;
  readonly success: boolean;
  readonly sourceRef?: string | null;
}

export interface ExperienceFeedbackResult {
  readonly experienceId: string;
  readonly successCount: number;
  readonly failureCount: number;
  readonly confidence: number;
  readonly lifecycle: ExperienceLifecycle;
}

export interface ExperienceMaintenanceOptions {
  readonly now?: number;
  readonly minFeedback?: number;
  readonly minConfidence?: number;
  readonly archiveAfterMs?: number;
}

export interface ExperienceMaintenanceResult {
  readonly deprecated: number;
  readonly archived: number;
}

export interface ExperienceStore {
  remember(draft: ExperienceDraft): Promise<{ experience: ExperienceEvent; created: boolean }>;
  search(query: ExperienceSearchQuery): Promise<readonly ExperienceHit[]>;
  list(query?: ExperienceListQuery): Promise<readonly ExperienceEvent[]>;
  feedback(input: ExperienceFeedbackInput): Promise<ExperienceFeedbackResult>;
  transition(experienceId: string, to: ExperienceLifecycle): Promise<ExperienceEvent>;
  maintenance(options?: ExperienceMaintenanceOptions): Promise<ExperienceMaintenanceResult>;
  close(): Promise<void>;
}
