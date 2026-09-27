CREATE TABLE content_topics (
  id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE content_topic_revisions (
  revision TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE content_imports (
  export_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  imported_at INTEGER NOT NULL
);
CREATE TABLE content_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  report_date TEXT NOT NULL,
  cutoff_at INTEGER NOT NULL,
  catalog_batch_id TEXT NOT NULL,
  raw_batch_id TEXT NOT NULL
);
CREATE TABLE content_ready (
  export_id TEXT PRIMARY KEY REFERENCES content_imports(export_id),
  snapshot_id TEXT NOT NULL REFERENCES content_snapshots(snapshot_id),
  report_date TEXT NOT NULL,
  cutoff_at INTEGER NOT NULL,
  ready_at INTEGER NOT NULL
);
CREATE INDEX content_ready_order ON content_ready(report_date DESC, cutoff_at DESC, ready_at DESC);
CREATE TABLE content_revocations (
  revision_id TEXT PRIMARY KEY,
  revoked_at INTEGER NOT NULL,
  reason TEXT NOT NULL
);
CREATE TABLE content_subscriptions (
  revision_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES users(id),
  subscription_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE content_preferences (
  member_id TEXT PRIMARY KEY REFERENCES users(id),
  revision TEXT NOT NULL REFERENCES content_subscriptions(revision_id),
  preferences_json TEXT NOT NULL
);
CREATE TABLE content_feedback (
  feedback_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES users(id),
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('read','saved','not-relevant','retract')),
  retracts_feedback_id TEXT REFERENCES content_feedback(feedback_id),
  occurred_at INTEGER NOT NULL
);
CREATE INDEX content_feedback_member ON content_feedback(member_id, occurred_at);
CREATE TABLE content_editions (
  edition_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES users(id),
  report_date TEXT NOT NULL,
  cutoff_at INTEGER NOT NULL,
  edition_json TEXT NOT NULL,
  assembly_input_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  finalized INTEGER NOT NULL CHECK(finalized IN (0,1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX content_editions_member ON content_editions(member_id, cutoff_at DESC);
CREATE TABLE content_edition_requests (
  member_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  subscription_revision TEXT NOT NULL,
  edition_id TEXT NOT NULL REFERENCES content_editions(edition_id),
  PRIMARY KEY(member_id, request_id)
);
