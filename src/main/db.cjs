const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

const schema = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE,
  bytes INTEGER NOT NULL, added_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'NEW', public_url TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY, media_id TEXT NOT NULL REFERENCES media(id), caption TEXT NOT NULL DEFAULT '',
  scheduled_at TEXT, published_at TEXT, status TEXT NOT NULL DEFAULT 'DRAFT',
  instagram_media_id TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_post_per_media ON posts(media_id)
  WHERE status IN ('SCHEDULED','PUBLISHING','PUBLISHED');
CREATE INDEX IF NOT EXISTS scheduled_posts ON posts(status, scheduled_at);
CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS caption_generations (id TEXT PRIMARY KEY, media_id TEXT, caption TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS instagram_account (id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT, user_id TEXT, account_type TEXT, token_expires_at TEXT, token_cipher TEXT, connected_at TEXT);
`;

class Database {
  constructor(file) { this.file = file; this.db = null; }
  async open() {
    const SQL = await initSqlJs({ locateFile: file => path.join(path.dirname(require.resolve('sql.js')), file) });
    this.db = fs.existsSync(this.file) ? new SQL.Database(fs.readFileSync(this.file)) : new SQL.Database();
    this.db.run(schema);
    this.save();
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, Buffer.from(this.db.export()));
    fs.renameSync(temporary, this.file);
  }
  all(sql, params = []) {
    const stmt = this.db.prepare(sql); stmt.bind(params); const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free(); return rows;
  }
  one(sql, params = []) { return this.all(sql, params)[0] || null; }
  run(sql, params = []) {
    this.db.run(sql, params); const changes = this.db.getRowsModified(); this.save(); return changes;
  }
}

module.exports = { Database };
