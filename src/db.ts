import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One process/host owns this SQLite file. Never pass an async function to transaction. */
export class Store {
  readonly db: DatabaseSync;
  private transactionDepth = 0;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
    for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      this.transaction(() => {
        if (this.db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(name)) return;
        this.db.exec(readFileSync(resolve(directory, name), 'utf8'));
        this.db.prepare('INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)').run(name, Date.now());
      });
    }
  }
  transaction<T>(fn: () => T): T {
    if (fn.constructor.name === 'AsyncFunction') throw new Error('Transactions must be synchronous');
    if (this.transactionDepth) throw new Error('Nested transactions are not supported');
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('Transactions must be synchronous');
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally { this.transactionDepth--; }
  }
  close(): void { this.db.close(); }
}
