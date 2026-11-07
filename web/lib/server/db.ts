import "server-only";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** One SQLite file holds everything the dashboard knows. */
const FILE = process.env.CARCAL_DB ?? path.join(os.homedir(), "carcal_data", "carcal.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bridges (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, token TEXT NOT NULL,
  device_json TEXT, created TEXT NOT NULL, last_ok TEXT
);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, car_json TEXT NOT NULL,
  bridge_id TEXT NOT NULL REFERENCES bridges(id),
  device_json TEXT NOT NULL, channels_json TEXT NOT NULL,
  target_json TEXT NOT NULL, settings_json TEXT NOT NULL,
  setup_complete INTEGER NOT NULL DEFAULT 0, last_applied TEXT,
  created TEXT NOT NULL, updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS measurements (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  key TEXT NOT NULL, spl_json TEXT NOT NULL, meta_json TEXT NOT NULL,
  crossovers_json TEXT, taken TEXT NOT NULL,
  PRIMARY KEY (profile_id, key)
);
CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  at TEXT NOT NULL, name TEXT NOT NULL, design TEXT NOT NULL,
  target_json TEXT NOT NULL, settings_json TEXT NOT NULL,
  request_json TEXT NOT NULL, result_json TEXT, applied INTEGER NOT NULL, verified INTEGER
);
`;

declare global {
  var __carcalDb: Database.Database | undefined;
}

export function db(): Database.Database {
  if (!globalThis.__carcalDb) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const d = new Database(FILE);
    d.pragma("journal_mode = WAL");
    d.pragma("foreign_keys = ON");
    d.exec(SCHEMA);
    globalThis.__carcalDb = d;
  }
  return globalThis.__carcalDb;
}

export const now = () => new Date().toISOString().slice(0, 19);
