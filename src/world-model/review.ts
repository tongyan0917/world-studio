import { hash } from "../kernel/stable.ts";
import { WorldIsolationError } from "./isolation.ts";
import type {
  ProjectionReviewProposal,
  WorldBlueprintPatch,
  WorldProjection,
} from "./types.ts";

export function proposeProjectionReviewChange(
  projectionId: string,
  projection: WorldProjection,
  requestedChange: string,
  patch: WorldBlueprintPatch,
  impact: ProjectionReviewProposal["impact"],
  provenance: readonly string[] = [],
): ProjectionReviewProposal {
  if (!projectionId) throw new Error("projectionId is required");
  if (!requestedChange.trim()) throw new Error("A review change must explain the requested semantic change");
  return {
    worldId: projection.worldId,
    id: `review:${projection.worldId}:${hash({ projectionId, source: projection.sourceStateHash, requestedChange, patch }).slice(0, 16)}`,
    projectionId,
    sourceRunId: projection.sourceRunId,
    sourceStateHash: projection.sourceStateHash,
    requestedChange,
    impact,
    patch: structuredClone(patch),
    provenance: [...provenance, `projection:${projectionId}`],
    status: "proposed",
  };
}

export function acceptReviewForCompilation(
  expectedWorldId: string,
  review: ProjectionReviewProposal,
): ProjectionReviewProposal {
  if (review.worldId !== expectedWorldId) throw new WorldIsolationError(`Review ${review.id} belongs to ${review.worldId}, not ${expectedWorldId}`);
  return { ...structuredClone(review), status: "accepted-for-compilation" };
}

export function rejectProjectionReview(review: ProjectionReviewProposal): ProjectionReviewProposal {
  return { ...structuredClone(review), status: "rejected" };
}
