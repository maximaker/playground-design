/**
 * Inviting people, and what each role can then do.
 *
 *   node scripts/members-check.mjs [base]
 *
 * The server side of this was checked when accounts landed; what is new is the
 * path a person actually walks — an owner making an invitation, a stranger
 * following the link, signing in, and landing in the document. Each step is
 * somewhere an invite can silently become a dead end.
 */

import { rawFetch, signedOutPage } from './lib/session.mjs';
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

/** A fetch that keeps its own cookie, so several people can be held at once. */
function person() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async call(path, init = {}) {
      const res = await fetch(`${BASE}${path}`, {
        ...init,
        headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers, cookie },
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return res;
    },
  };
}

const stamp = Date.now();
const owner = person();
const invitee = person();
const stranger = person();

const signUp = async (who, email) => who.call('/api/auth/signup', {
  method: 'POST',
  body: JSON.stringify({ email, password: 'a-long-enough-password', name: email.split('@')[0] }),
});

await signUp(owner, `owner-${stamp}@example.com`);
await signUp(stranger, `stranger-${stamp}@example.com`);

const doc = (await (await owner.call('/api/documents', {
  method: 'POST', body: JSON.stringify({ name: `Members check ${stamp}` }),
})).json()).document;

// --- Inviting someone who already has an account ----------------------------

const direct = await owner.call(`/api/documents/${doc.id}/invites`, {
  method: 'POST', body: JSON.stringify({ email: `stranger-${stamp}@example.com`, role: 'viewer' }),
});
const directBody = await direct.json();
check('an address with an account is added on the spot, not sent a link',
  direct.status === 201 && !!directBody.added && !directBody.invite, JSON.stringify(directBody).slice(0, 90));
check('and they can open the document now', (await stranger.call(`/api/documents/${doc.id}`)).ok);

// --- Inviting someone who does not ------------------------------------------

const inviteEmail = `invitee-${stamp}@example.com`;
const made = await (await owner.call(`/api/documents/${doc.id}/invites`, {
  method: 'POST', body: JSON.stringify({ email: inviteEmail, role: 'editor' }),
})).json();
check('an unknown address produces a link instead', !!made.invite?.url, made.invite?.url ?? JSON.stringify(made));
const token = made.invite.token;

const listed = await (await owner.call(`/api/documents/${doc.id}/invites`)).json();
check('the invitation is listed as pending', listed.invites.some((i) => i.token === token));

// Genuinely anonymous: the shared helper signs itself in on a 401, which would
// answer a different question than the one being asked here.
const anonymous = await rawFetch(`${BASE}/api/invites/${token}`);
check('anyone holding the link can read what it is for', anonymous.ok);
const preview = await anonymous.json();
check('and it says which document and which role',
  preview.document.name.includes('Members check') && preview.role === 'editor');

const withoutAccount = await rawFetch(`${BASE}/api/invites/${token}/accept`, { method: 'POST' });
check('accepting without an account is refused, and says why',
  withoutAccount.status === 401 && (await withoutAccount.json()).needsAuth === true);

// The invitation names an address; a different account must not be able to use it.
const wrongPerson = await stranger.call(`/api/invites/${token}/accept`, { method: 'POST' });
check('an invitation addressed to someone else is refused', wrongPerson.status === 403,
  `${wrongPerson.status}`);

await signUp(invitee, inviteEmail);
const accepted = await invitee.call(`/api/invites/${token}/accept`, { method: 'POST' });
check('the person it names can accept it', accepted.ok);
check('and is then an editor, not a viewer',
  (await invitee.call(`/api/documents/${doc.id}/ops`, { method: 'POST', body: JSON.stringify({ ops: [] }) })).ok);

const reused = await invitee.call(`/api/invites/${token}/accept`, { method: 'POST' });
check('following their own link again still works', reused.ok, `${reused.status}`);

const afterAccept = await (await owner.call(`/api/documents/${doc.id}/invites`)).json();
check('an accepted invitation stops being pending',
  !afterAccept.invites.some((i) => i.token === token));

// --- Roles are the server's to enforce ---------------------------------------

const editorInvites = await invitee.call(`/api/documents/${doc.id}/invites`, {
  method: 'POST', body: JSON.stringify({ role: 'owner' }),
});
check('an editor cannot invite anyone', editorInvites.status === 403, `${editorInvites.status}`);

const openLink = await (await owner.call(`/api/documents/${doc.id}/invites`, {
  method: 'POST', body: JSON.stringify({ role: 'viewer' }),
})).json();
check('an invitation with no address is a link for anyone signed in', !!openLink.invite?.url);

await owner.call(`/api/documents/${doc.id}/invites/${openLink.invite.token}`, { method: 'DELETE' });
const withdrawn = await rawFetch(`${BASE}/api/invites/${openLink.invite.token}`);
check('withdrawing one takes it out immediately', withdrawn.status === 404, `${withdrawn.status}`);

// --- The same trip through the interface ---------------------------------------

const browser = await chromium.launch({ headless: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
page.on('pageerror', (e) => errors.push(e.message));

// Signed in as the owner: the Share modal has to offer the People half.
await page.context().addCookies([{
  name: owner.cookie.split('=')[0], value: owner.cookie.split('=').slice(1).join('='),
  url: BASE,
}]);
await page.goto(`${BASE}/d/${doc.id}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.artboard-frame iframe', { timeout: 30000 });
await page.click('button:has-text("Share")');
await page.waitForSelector('.modal', { timeout: 10000 });
await page.waitForTimeout(800);

check('the share modal lists the people', (await page.locator('.people-list li').count()) >= 2,
  `${await page.locator('.people-list li').count()} rows`);
check('an owner gets the invite form', (await page.locator('.people-invite').count()) === 1);
check('and can change a role from the list', (await page.locator('.people-role').count()) >= 2);

const newLink = await page.evaluate(async (docId) => {
  const res = await fetch(`/api/documents/${docId}/invites`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'viewer' }),
  });
  return (await res.json()).invite.url;
}, doc.id);

// Following the link in a browser with no session: the invitation explains
// itself above the sign-in form rather than dumping the person on it.
// Deliberately signed out: this is the state the link is followed in.
const fresh = await signedOutPage(browser, { viewport: { width: 1400, height: 950 } });
fresh.on('pageerror', (e) => errors.push(e.message));
await fresh.goto(newLink, { waitUntil: 'networkidle' });
await fresh.waitForTimeout(1200);
check('a signed-out visitor is told what they were invited to',
  (await fresh.locator('.join-banner').count()) === 1
  && (await fresh.locator('.auth-card').count()) === 1);

// Create the account from here: this is the path someone invited to a tool
// they have never used actually walks.
const toSignUp = fresh.locator('.auth-switch');
if (await toSignUp.count()) await toSignUp.click();
await fresh.waitForTimeout(300);
await fresh.fill('.auth-card input[type=email]', `joiner-${stamp}@example.com`);
await fresh.fill('.auth-card input[type=password]', 'a-long-enough-password');
await fresh.click('.auth-card button[type=submit]');
await fresh.waitForTimeout(1500);
check('signing up from the invitation comes back to it',
  (await fresh.locator('.join-card').count()) === 1, fresh.url());

await fresh.click('.join-card .button.primary');
await fresh.waitForURL(/\/d\/doc_/, { timeout: 20000 }).catch(() => {});
await fresh.waitForTimeout(1500);
check('accepting opens the document', fresh.url().includes(`/d/${doc.id}`), fresh.url());

await page.screenshot({ path: '/tmp/people-panel.png' });
check('no runtime errors', errors.length === 0, errors[0] ?? '');

await browser.close();
await owner.call(`/api/documents/${doc.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
