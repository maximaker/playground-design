import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEmptyDocument } from '@playground/shared';
import { SqlitePersistence } from './persistence-sqlite.ts';

test('the activity log survives a restart (sqlite)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-hist-'));
  try {
    const path = join(dir, 'h.db');
    const a = new SqlitePersistence(path);
    const doc = createEmptyDocument('History test');
    await a.saveDocument(doc);
    const entries = [{ rev: 1, label: 'Added 1 layer', origin: { kind: 'human', id: 'u' }, ts: 1, opCount: 1 }];
    await a.saveHistory(doc.id, entries);
    await a.saveHistory(doc.id, [...entries, { ...entries[0], rev: 2 }]);
    const b = new SqlitePersistence(path); // a fresh process opening the same file
    assert.equal((await b.loadHistory(doc.id)).length, 2);
    assert.deepEqual(await b.loadHistory('missing'), []);
  } finally {
    // Windows keeps the open database file locked; leftover temp files are harmless.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked */ }
  }
});
