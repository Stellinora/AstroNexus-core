export type MemoryKind =
  | "fact"
  | "preference"
  | "decision"
  | "workflow"
  | "blocker"
  | "reflection";

export type MemoryLifecycle = "active" | "decayed" | "archived" | "soft_deleted";

export interface MemoryEvent {
  readonly eventId: number;
  readonly memoryId: string;
  readonly supersedesId: number | null;
  readonly kind: MemoryKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly searchText: string;
  readonly eventTime: number;
  readonly ingestedAt: number;
  readonly lifecycle: MemoryLifecycle;
  readonly sourceRef: string | null;
  readonly externalId: string | null;
}

export interface IngestInput {
  readonly memoryId?: string;
  readonly kind: MemoryKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly searchText?: string;
  readonly eventTime?: number;
  readonly sourceRef?: string | null;
  readonly externalId?: string | null;
}

export interface IngestResult {
  readonly event: MemoryEvent;
  readonly created: boolean;
}

export interface CorrectInput {
  readonly memoryId: string;
  readonly kind?: MemoryKind;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly searchText?: string;
  readonly sourceRef?: string | null;
  readonly externalId?: string | null;
}

export interface CorrectResult {
  readonly event: MemoryEvent;
  readonly previousEventId: number | null;
}

export interface RetrieveQuery {
  readonly text: string;
  readonly kind?: MemoryKind;
  readonly sourceRefPrefix?: string;
  readonly limit?: number;
}

export interface RetrievalHit {
  readonly event: MemoryEvent;
  readonly score: number;
}

export interface ListQuery {
  readonly kind?: MemoryKind;
  readonly lifecycles?: readonly MemoryLifecycle[];
  readonly limit?: number;
}

export interface BootRequest {
  readonly tokenBudget?: number;
  readonly maxItems?: number;
  readonly kinds?: readonly MemoryKind[];
}

export interface BootItem {
  readonly memoryId: string;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly sourceRef: string | null;
}

export interface BootSnapshot {
  readonly items: readonly BootItem[];
  readonly text: string;
  readonly tokenEstimate: number;
}

export interface MemoryStore {
  ingest(input: IngestInput): Promise<IngestResult>;
  correct(input: CorrectInput): Promise<CorrectResult>;
  transition(memoryId: string, to: MemoryLifecycle): Promise<MemoryEvent>;
  retrieve(query: RetrieveQuery): Promise<readonly RetrievalHit[]>;
  list(query?: ListQuery): Promise<readonly MemoryEvent[]>;
  maintenance(options?: MaintenanceOptions): Promise<MaintenanceResult>;
  stats(): Promise<MemoryStats>;
  boot(request?: BootRequest): BootSnapshot;
  exportJsonl(): AsyncIterable<string>;
  close(): Promise<void>;
}

export interface MaintenanceOptions {
  readonly now?: number;
  readonly decayAfterMs?: number;
  readonly archiveAfterMs?: number;
}

export interface MaintenanceResult {
  readonly archivedDuplicates: number;
  readonly decayed: number;
  readonly archived: number;
}

export interface MemoryStats {
  readonly totalEvents: number;
  readonly active: number;
  readonly byKind: Readonly<Record<MemoryKind, number>>;
  readonly byLifecycle: Readonly<Record<MemoryLifecycle, number>>;
}
