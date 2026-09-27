import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

const source = path.resolve(process.env.MEMBER_DATABASE_PATH || "data/member.sqlite");
const output = path.resolve(process.argv[2] || `data/backups/member-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
if (output === source || fs.existsSync(output)) throw new Error("Choose a new backup file; existing files are not overwritten");
if (!fs.existsSync(source)) throw new Error("Member database does not exist");
fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(source, { readOnly: true });
try { await backup(db, output); fs.chmodSync(output, 0o600); console.log("Private database backup completed"); }
finally { db.close(); }
