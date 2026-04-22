import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    description: "baseline schema",
    sql: `
CREATE TABLE IF NOT EXISTS part_types (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  category TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  image_url TEXT,
  notes TEXT,
  countable INTEGER NOT NULL,
  needs_review INTEGER NOT NULL DEFAULT 1,
  partdb_part_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS qr_batches (
  id TEXT PRIMARY KEY,
  prefix TEXT NOT NULL,
  start_number INTEGER NOT NULL,
  end_number INTEGER NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS qrcodes (
  code TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES qr_batches(id),
  status TEXT NOT NULL,
  assigned_kind TEXT,
  assigned_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS physical_instances (
  id TEXT PRIMARY KEY,
  qr_code TEXT NOT NULL UNIQUE REFERENCES qrcodes(code),
  part_type_id TEXT NOT NULL REFERENCES part_types(id),
  status TEXT NOT NULL,
  location TEXT NOT NULL,
  assignee TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bulk_stocks (
  id TEXT PRIMARY KEY,
  qr_code TEXT NOT NULL UNIQUE REFERENCES qrcodes(code),
  part_type_id TEXT NOT NULL REFERENCES part_types(id),
  level TEXT NOT NULL,
  location TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_events (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  event TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  location TEXT,
  actor TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL
);
    `,
  },
  {
    version: 2,
    description: "version columns and idempotency keys",
    sql: `
ALTER TABLE physical_instances ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bulk_stocks ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
    `,
  },
  {
    version: 3,
    description: "auth sessions",
    sql: `
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT,
  email TEXT,
  roles_json TEXT NOT NULL DEFAULT '[]',
  id_token TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx
  ON auth_sessions (expires_at);
    `,
  },
  {
    version: 4,
    description: "partdb sync model foundations",
    sql: `
ALTER TABLE bulk_stocks ADD COLUMN quantity REAL NOT NULL DEFAULT 0;
ALTER TABLE bulk_stocks ADD COLUMN minimum_quantity REAL;
ALTER TABLE bulk_stocks ADD COLUMN partdb_lot_id TEXT;
ALTER TABLE bulk_stocks ADD COLUMN partdb_sync_status TEXT NOT NULL DEFAULT 'never';

ALTER TABLE physical_instances ADD COLUMN partdb_lot_id TEXT;

ALTER TABLE part_types ADD COLUMN category_path_json TEXT NOT NULL DEFAULT '["Uncategorized"]';
ALTER TABLE part_types ADD COLUMN unit_symbol TEXT NOT NULL DEFAULT 'pcs';
ALTER TABLE part_types ADD COLUMN unit_name TEXT NOT NULL DEFAULT 'Pieces';
ALTER TABLE part_types ADD COLUMN unit_is_integer INTEGER NOT NULL DEFAULT 1;
ALTER TABLE part_types ADD COLUMN partdb_category_id TEXT;
ALTER TABLE part_types ADD COLUMN partdb_unit_id TEXT;
ALTER TABLE part_types ADD COLUMN partdb_sync_status TEXT NOT NULL DEFAULT 'never';

UPDATE part_types
SET category_path_json = json_array(category)
WHERE category_path_json = '["Uncategorized"]' OR category_path_json = '[]';

UPDATE bulk_stocks
SET quantity = CASE level
  WHEN 'full' THEN 100
  WHEN 'good' THEN 75
  WHEN 'low' THEN 25
  WHEN 'empty' THEN 0
  ELSE 0
END
WHERE quantity = 0;

CREATE TABLE IF NOT EXISTS partdb_category_cache (
  path_key TEXT PRIMARY KEY,
  partdb_iri TEXT NOT NULL,
  cached_at TEXT NOT NULL
);
    `,
  },
  {
    version: 5,
    description: "partdb outbox",
    sql: `
CREATE TABLE IF NOT EXISTS partdb_outbox (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  correlation_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  depends_on_id TEXT REFERENCES partdb_outbox(id),
  target_table TEXT,
  target_row_id TEXT,
  target_column TEXT,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 10,
  lease_expires_at TEXT,
  next_attempt_at TEXT NOT NULL,
  last_error_json TEXT,
  response_json TEXT,
  response_iri TEXT,
  created_at TEXT NOT NULL,
  leased_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS partdb_outbox_worker_idx
  ON partdb_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS partdb_outbox_correlation_idx
  ON partdb_outbox(correlation_id);
CREATE INDEX IF NOT EXISTS partdb_outbox_target_idx
  ON partdb_outbox(target_table, target_row_id);
    `,
  },
  {
    version: 6,
    description: "partdb outbox failure timestamps",
    sql: `
ALTER TABLE partdb_outbox ADD COLUMN last_failure_at TEXT;
    `,
  },
  {
    version: 7,
    description: "physical instance sync status",
    sql: `
ALTER TABLE physical_instances ADD COLUMN partdb_sync_status TEXT NOT NULL DEFAULT 'never';
    `,
  },
  {
    version: 8,
    description: "correction events",
    sql: `
CREATE TABLE IF NOT EXISTS correction_events (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  correction_kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS correction_events_target_idx
  ON correction_events (target_type, target_id, created_at DESC);
    `,
  },
  {
    version: 9,
    description: "borrow records for countable instances",
    sql: `
CREATE TABLE IF NOT EXISTS borrow_records (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES physical_instances(id),
  borrower TEXT NOT NULL,
  borrowed_at TEXT NOT NULL,
  due_at TEXT,
  returned_at TEXT,
  close_reason TEXT,
  notes TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS borrow_records_open_one_per_instance
  ON borrow_records(instance_id) WHERE returned_at IS NULL;

CREATE INDEX IF NOT EXISTS borrow_records_overdue_idx
  ON borrow_records(due_at) WHERE returned_at IS NULL;

INSERT INTO borrow_records (id, instance_id, borrower, borrowed_at, due_at, returned_at, close_reason, notes, actor, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
  pi.id,
  COALESCE(NULLIF(TRIM(pi.assignee), ''), 'unknown (migrated)'),
  pi.updated_at,
  NULL,
  NULL,
  NULL,
  NULL,
  'migration',
  pi.updated_at
FROM physical_instances pi
WHERE pi.status = 'checked_out'
  AND NOT EXISTS (
    SELECT 1 FROM borrow_records br
    WHERE br.instance_id = pi.id AND br.returned_at IS NULL
  );
    `,
  },
  {
    version: 10,
    description: "partdb storage location cache",
    sql: `
CREATE TABLE IF NOT EXISTS partdb_location_cache (
  path_key TEXT PRIMARY KEY,
  partdb_iri TEXT NOT NULL,
  cached_at TEXT NOT NULL
);
    `,
  },
  {
    version: 11,
    description: "unified entities table backfilled from instances and bulk_stocks",
    sql: `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  qr_code TEXT NOT NULL UNIQUE REFERENCES qrcodes(code),
  part_type_id TEXT NOT NULL REFERENCES part_types(id),
  location TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  minimum_quantity REAL,
  status TEXT NOT NULL DEFAULT 'available',
  assignee TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  partdb_lot_id TEXT,
  partdb_sync_status TEXT NOT NULL DEFAULT 'never',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('instance', 'bulk'))
);

CREATE INDEX IF NOT EXISTS entities_part_type_idx ON entities(part_type_id);
CREATE INDEX IF NOT EXISTS entities_status_idx ON entities(status);

INSERT OR IGNORE INTO entities (id, qr_code, part_type_id, location, quantity, minimum_quantity, status, assignee, version, partdb_lot_id, partdb_sync_status, created_at, updated_at, source_kind)
SELECT id, qr_code, part_type_id, location, 1, NULL, status, assignee, version, partdb_lot_id, partdb_sync_status, created_at, updated_at, 'instance'
FROM physical_instances;

INSERT OR IGNORE INTO entities (id, qr_code, part_type_id, location, quantity, minimum_quantity, status, assignee, version, partdb_lot_id, partdb_sync_status, created_at, updated_at, source_kind)
SELECT id, qr_code, part_type_id, location, quantity, minimum_quantity, 'available', NULL, version, partdb_lot_id, partdb_sync_status, created_at, updated_at, 'bulk'
FROM bulk_stocks;
    `,
  },
  {
    version: 12,
    description: "branch-merge catch-up for borrow_records",
    sql: `
CREATE TABLE IF NOT EXISTS borrow_records (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES physical_instances(id),
  borrower TEXT NOT NULL,
  borrowed_at TEXT NOT NULL,
  due_at TEXT,
  returned_at TEXT,
  close_reason TEXT,
  notes TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS borrow_records_open_one_per_instance
  ON borrow_records(instance_id) WHERE returned_at IS NULL;

CREATE INDEX IF NOT EXISTS borrow_records_overdue_idx
  ON borrow_records(due_at) WHERE returned_at IS NULL;

INSERT INTO borrow_records (id, instance_id, borrower, borrowed_at, due_at, returned_at, close_reason, notes, actor, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
  pi.id,
  COALESCE(NULLIF(TRIM(pi.assignee), ''), 'unknown (migrated)'),
  pi.updated_at,
  NULL,
  NULL,
  NULL,
  NULL,
  'migration',
  pi.updated_at
FROM physical_instances pi
WHERE pi.status = 'checked_out'
  AND NOT EXISTS (
    SELECT 1 FROM borrow_records br
    WHERE br.instance_id = pi.id AND br.returned_at IS NULL
  );
    `,
  },
  {
    version: 13,
    description: "branch-merge catch-up for partdb storage location cache",
    sql: `
CREATE TABLE IF NOT EXISTS partdb_location_cache (
  path_key TEXT PRIMARY KEY,
  partdb_iri TEXT NOT NULL,
  cached_at TEXT NOT NULL
);
    `,
  },
  {
    version: 14,
    description: "standalone known_categories table",
    sql: `
CREATE TABLE IF NOT EXISTS known_categories (
  path TEXT PRIMARY KEY
);
    `,
  },
  {
    version: 15,
    description: "standalone known_locations table",
    sql: `
CREATE TABLE IF NOT EXISTS known_locations (
  path TEXT PRIMARY KEY
);
    `,
  },
];

export function applyMigrations(
  db: DatabaseSync,
  customMigrations: Migration[] = migrations,
): { applied: number; current: number } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const row = db
    .prepare(`SELECT COALESCE(MAX(version), 0) AS current_version FROM schema_version`)
    .get() as { current_version: number };
  const currentVersion = Number(row.current_version);

  const pending = customMigrations.filter((m) => m.version > currentVersion);
  if (pending.length === 0) {
    return { applied: 0, current: currentVersion };
  }

  for (const migration of pending) {
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare(
        `INSERT INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)`,
      ).run(migration.version, migration.description, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return { applied: pending.length, current: pending[pending.length - 1]!.version };
}
