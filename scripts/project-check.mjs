/**
 * Projects, end to end.
 *
 * Two things carry most of the risk. Filing is written to the cached document
 * and flushed later, so any count read straight from storage lags behind and a
 * freshly filed document appears nowhere — that is checked by reading the count
 * back immediately. And deleting a project must never delete a document, which
 * is checked by deleting one that has documents in it and counting them after.
 */

import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

const api = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// --- The API --------------------------------------------------------------

const made = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: '  Website   refresh ' }) });
const project = made.body.project;
check('a project can be created', made.status === 201 && !!project?.id, project?.id ?? '');
check('the name is tidied, not taken literally', project?.name === 'Website refresh', project?.name ?? '');

const unnamed = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: '   ' }) });
check('an empty name is refused', unnamed.status === 400, String(unnamed.status));

const doc = await api('/api/documents', {
  method: 'POST', body: JSON.stringify({ name: 'Filed at birth', template: 'clean', projectId: project.id }),
});
const docId = doc.body.document.id;

// Read straight back: this is the case where a storage-only count reports zero,
// because the document has been filed in the cache but not yet flushed.
const listed = (await api('/api/projects')).body.projects.find((p) => p.id === project.id);
check('a document created into a project is counted at once', listed?.documentCount === 1,
  `count ${listed?.documentCount}`);

const loose = await api('/api/documents', { method: 'POST', body: JSON.stringify({ name: 'Unfiled one' }) });
const looseId = loose.body.document.id;

const moved = await api(`/api/documents/${looseId}/project`, {
  method: 'PUT', body: JSON.stringify({ projectId: project.id }),
});
check('a document can be moved in', moved.status === 200);

const afterMove = (await api('/api/projects')).body.projects.find((p) => p.id === project.id);
check('and the count follows', afterMove?.documentCount === 2, `count ${afterMove?.documentCount}`);

const out = await api(`/api/documents/${looseId}/project`, { method: 'PUT', body: JSON.stringify({ projectId: null }) });
check('and can be moved back out', out.status === 200);

const bogus = await api(`/api/documents/${docId}/project`, {
  method: 'PUT', body: JSON.stringify({ projectId: 'proj_nonexistent' }),
});
check('filing into a project that does not exist is refused', bogus.status === 404, String(bogus.status));

const renamed = await api(`/api/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Website' }) });
check('a project can be renamed', renamed.body.project?.name === 'Website', renamed.body.project?.name ?? '');

// --- Deleting a project must not delete documents -------------------------

const before = (await api('/api/documents')).body.documents.length;
const removed = await api(`/api/projects/${project.id}`, { method: 'DELETE' });
check('deleting reports how many documents it unfiled', removed.body.unfiled === 1, String(removed.body.unfiled));

const after = (await api('/api/documents')).body.documents;
check('no document was deleted with it', after.length === before, `${before} -> ${after.length}`);
check('its documents are unfiled, not orphaned',
  !after.find((d) => d.id === docId)?.projectId, String(after.find((d) => d.id === docId)?.projectId));
check('the project itself is gone',
  !(await api('/api/projects')).body.projects.some((p) => p.id === project.id));

// --- The library ----------------------------------------------------------

const p2 = (await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Drag target' }) })).body.project;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('.library', { timeout: 20000 });

check('projects are listed beside the documents',
  await page.locator('.library-row.is-project').count() >= 1);

// Filter to the empty project: the list should be empty and say what to do.
await page.locator('.library-row.is-project', { hasText: 'Drag target' }).locator('.library-row-main').click();
await page.waitForTimeout(400);
check('an empty project shows no documents', await page.locator('.home-card').count() === 0);

await page.locator('.library-row', { hasText: 'All documents' }).first().click();
await page.waitForTimeout(400);

/** Dragging a card onto a project row, with the private mime type it uses. */
const dragCardTo = (cardTitle, projectName) => page.evaluate(([title, name]) => {
  const card = [...document.querySelectorAll('.home-card')].find((c) => c.querySelector('h3')?.textContent === title);
  const row = [...document.querySelectorAll('.library-row.is-project')].find((r) => r.textContent.includes(name));
  if (!card || !row) return false;
  const dt = new DataTransfer();
  card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  row.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return true;
}, [cardTitle, projectName]);

check('the card and the target are both present', await dragCardTo('Filed at birth', 'Drag target'));
await page.waitForTimeout(1200);

const dropped = (await api('/api/documents')).body.documents.find((d) => d.id === docId);
check('dragging a document onto a project files it', dropped?.projectId === p2.id,
  dropped?.projectId ?? 'unfiled');

// An unrelated drag — a file, say — must not be treated as a document move.
const ignored = await page.evaluate(() => {
  const row = document.querySelector('.library-row.is-project');
  const dt = new DataTransfer();
  dt.setData('text/plain', 'not a document');
  row.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return row.className.includes('is-drop-target');
});
check('a drag carrying something else is ignored', ignored === false);

check('no runtime errors', errors.length === 0, errors[0] ?? '');

await browser.close();
await api(`/api/projects/${p2.id}`, { method: 'DELETE' });
for (const id of [docId, looseId]) await api(`/api/documents/${id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
