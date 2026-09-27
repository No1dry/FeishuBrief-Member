import assert from "node:assert/strict";
import test from "node:test";
import { exportFixture, fixtureClone, rehashFixture, FIXTURE_NOW } from "./export-fixture";
import { verifyEngineExport } from "../src/proof";
import { ContentError, ContentService } from "../src/content";
import { Store } from "../src/db";
import { personalHash } from "../src/engine/personal-contract";
import type { MemberExport } from "../src/engine/member-export-contract";

test("real export verifier reproduces the full qualified pool and exact catalog provenance", () => {
  const fixture = exportFixture(), result = verifyEngineExport(fixture);
  assert.equal(result.snapshot.snapshotId, fixture.snapshot.snapshotId);
  assert.equal(result.catalogBatchId, fixture.catalogBatchId);
  assert.equal(result.rawBatchId, fixture.batches[0].raw.rawBatchId);
  assert.equal(result.snapshot.items.length, 2);
  const revoked = verifyEngineExport(exportFixture({ revokeFirst: true }));
  assert.equal(revoked.snapshot.items.length, 1); assert.equal(revoked.revokedRevisionIds.length, 1);
});

test("rehashed title, quality, unsupported evidence, invisible sources and omitted revocations fail the real proof boundary", () => {
  const variants: Array<[string, MemberExport]> = [];
  const title = fixtureClone(exportFixture()); title.snapshot.items[0].title = "Forged title outside original evidence";
  variants.push(["title", rehashFixture(title)]);
  const quality = fixtureClone(exportFixture()); quality.snapshot.items[0].quality = 100;
  variants.push(["quality", rehashFixture(quality)]);
  const evidence = fixtureClone(exportFixture()); evidence.batches[0].batch.items[0].understood.claims[0].quote = "Invented quote missing from source evidence";
  variants.push(["evidence", rehashFixture(evidence)]);
  const visibility = fixtureClone(exportFixture()); visibility.batches[0].raw.candidates[0].visible = false;
  variants.push(["visibility", rehashFixture(visibility)]);
  const revoked = fixtureClone(exportFixture({ revokeFirst: true })); revoked.revokedRevisionIds = [];
  variants.push(["revocation omission", rehashFixture(revoked)]);
  const partial = fixtureClone(exportFixture()); partial.batches = [];
  const { exportId: _partialId, ...partialBody } = partial;
  variants.push(["partial proof", { ...partialBody, exportId: personalHash(partialBody) }]);
  for (const [name, value] of variants) {
    assert.throws(() => verifyEngineExport(value), `${name} must be rejected`);
    const store = new Store(":memory:");
    try {
      const service = new ContentService(store, { now: () => new Date(FIXTURE_NOW), verifyExport: verifyEngineExport });
      assert.throws(() => service.importExport(value), error => error instanceof ContentError && error.status === 400 && error.code === "invalid_export", name);
      assert.equal(Number(store.db.prepare("SELECT count(*) AS n FROM content_ready").get()!.n), 0);
      assert.equal(Number(store.db.prepare("SELECT count(*) AS n FROM content_imports").get()!.n), 0);
      assert.equal(Number(store.db.prepare("SELECT count(*) AS n FROM content_topics").get()!.n), 0);
    } finally { store.close(); }
  }
});
