import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Database = DatabaseSync;

/**
 * Token amounts and USD micros are TEXT: 18-decimal amounts overflow SQLite's
 * 64-bit integers. Times are milliseconds since the epoch.
 *
 * A tab moves open → claiming → activating → active → settling → closed.
 * `open` tabs have no key yet; `settling` tabs have a disabled key and wait
 * for final usage. Any tab can jump to `closed` when the chain says so.
 */
const MIGRATIONS = [
  `
  CREATE TABLE tabs (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    token TEXT NOT NULL,
    locked TEXT NOT NULL,
    opened_tx TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'claiming', 'activating', 'active', 'settling', 'closed')),
    close_requested INTEGER NOT NULL DEFAULT 0,
    decimals INTEGER,
    price_e18 TEXT,
    markup_bps TEXT,
    allowance_micros TEXT NOT NULL DEFAULT '0',
    usage_micros TEXT NOT NULL DEFAULT '0',
    charged TEXT NOT NULL DEFAULT '0',
    charge_posted TEXT NOT NULL DEFAULT '0',
    charge_posted_at INTEGER,
    key_hash TEXT UNIQUE,
    key_hint TEXT,
    claimed_at INTEGER,
    disabled_at INTEGER,
    refunded TEXT,
    forced INTEGER,
    closed_at INTEGER,
    next_check_at INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE INDEX tabs_owner ON tabs (owner, opened_at);
  CREATE INDEX tabs_state ON tabs (state);
  CREATE TABLE seen_logs (tx TEXT NOT NULL, log_index INTEGER NOT NULL, PRIMARY KEY (tx, log_index));
  CREATE TABLE cursors (name TEXT PRIMARY KEY, block TEXT NOT NULL);
  `,
];

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let i = version; i < MIGRATIONS.length; i++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
  return db;
}

export function transaction<T>(db: Database, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export type TabState = "open" | "claiming" | "activating" | "active" | "settling" | "closed";

export type TabRow = {
  id: string;
  owner: string;
  token: string;
  locked: string;
  opened_tx: string;
  opened_at: number;
  state: TabState;
  close_requested: number;
  decimals: number | null;
  price_e18: string | null;
  markup_bps: string | null;
  allowance_micros: string;
  usage_micros: string;
  charged: string;
  charge_posted: string;
  charge_posted_at: number | null;
  key_hash: string | null;
  key_hint: string | null;
  claimed_at: number | null;
  disabled_at: number | null;
  refunded: string | null;
  forced: number | null;
  closed_at: number | null;
  next_check_at: number;
  error: string | null;
};

export function getTab(db: Database, id: string): TabRow | undefined {
  return db.prepare("SELECT * FROM tabs WHERE id = ?").get(id) as TabRow | undefined;
}

export function tabsInState(db: Database, ...states: TabState[]): TabRow[] {
  return db.prepare(`SELECT * FROM tabs WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY opened_at`).all(...states) as TabRow[];
}

/** Updates the given columns of one tab. */
export function updateTab(db: Database, id: string, fields: Partial<Omit<TabRow, "id">>): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  db.prepare(`UPDATE tabs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => (fields as Record<string, any>)[k] ?? null), id);
}

/** Updates a tab only if it is still in `state`, so a racing step cannot undo another's move. Returns whether it did. */
export function moveTab(db: Database, id: string, state: TabState, fields: Partial<Omit<TabRow, "id">>): boolean {
  const keys = Object.keys(fields);
  const result = db.prepare(`UPDATE tabs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ? AND state = ?`)
    .run(...keys.map((k) => (fields as Record<string, any>)[k] ?? null), id, state);
  return result.changes > 0;
}
