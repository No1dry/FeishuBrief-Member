import { validateMemberExport } from "./engine/member-export-contract";
import type { VerifiedExport } from "./content";

export function verifyEngineExport(value: unknown): VerifiedExport {
  const proof = validateMemberExport(value);
  const catalog = proof.batches.find(p => p.batch.batchId === proof.catalogBatchId)!;
  return { exportId: proof.exportId, generatedAt: proof.generatedAt, snapshot: proof.snapshot,
    catalogBatchId: proof.catalogBatchId, rawBatchId: catalog.batch.rawBatchId, profiles: catalog.profiles,
    revokedRevisionIds: proof.revokedRevisionIds, proof };
}
