export interface EpisodeMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly seq: number;
}

export interface Episode {
  readonly episodeId: number;
  readonly sessionId: string;
  readonly turn: number;
  readonly transcript: readonly EpisodeMessage[];
  readonly startedAt: number;
  readonly endedAt: number;
  readonly reflectedAt: number | null;
}

export interface EpisodeInput {
  readonly sessionId: string;
  readonly turn: number;
  readonly transcript: readonly EpisodeMessage[];
  readonly startedAt: number;
  readonly endedAt: number;
}

export interface EpisodeStore {
  record(input: EpisodeInput): Promise<Episode>;
  recentUnreflected(limit?: number): Promise<readonly Episode[]>;
  markReflected(episodeIds: readonly number[]): Promise<void>;
  close(): Promise<void>;
}
