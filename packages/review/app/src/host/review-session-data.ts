import type { LoadedAgentTrace } from "@canvas/use-agent-trace";
import type { ReviewBoardPlace } from "@dev.fast/review-protocol";

export interface ReviewSessionData {
  trashedAt?: string | null;
  reviewId: string;
  /** Absent for a document whose references all carry their own pins. */
  pins?: { base: string; head: string };
  /** `worktree` when the head side is the checkout's working files rather
   * than the pinned head commit. */
  targetKind?: "worktree" | "commits" | "project";
  historicalRevision: string | null;
  updatedAtMs: number;
  /** Head branch captured with the displayed snapshot. */
  headBranch?: string;
  /** The target's base and head as written, a branch name or a commit. */
  baseRef?: string;
  headRef?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  traces: ReadonlyMap<string, LoadedAgentTrace>;
  /** Its parent, siblings and PR facts, read for its header. */
  place(signal: AbortSignal): Promise<ReviewBoardPlace>;
  /** Changes whenever `place` would read something new. */
  placeRevision?: number;
  /** Moves the board to Trash, asking first when other boards need it.
   * False when the person kept it. */
  dismiss(): Promise<boolean>;
}
