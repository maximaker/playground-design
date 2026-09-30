/**
 * A detailed authentication flow, drawn over MCP onto its own page.
 *
 *   node scripts/agent/auth-flow.mjs <docId> [base]
 */
import '../lib/session.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeFileSync } from 'node:fs';

const DOC = process.argv[2];
const BASE = process.argv[3] ?? 'https://playground.thedigitalvitamins.com';
const code = (await (await fetch(`${BASE}/api/documents/${DOC}/connections`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'auth flow' }),
})).text()).match(/\/mcp\/([A-Z0-9-]+)/)[1];
const client = new Client({ name: 'auth-flow', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/${code}`)));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  if (r.isError) throw new Error(`${name}: ${t}`);
  return { json: (() => { try { return JSON.parse(t); } catch { return t; } })(), raw: r };
};

const pages = (await call('list_pages', {})).json.pages;
let page = pages.find((p) => p.name === 'Authentication flow');
if (!page) page = { id: (await call('create_page', { name: 'Authentication flow', switchTo: true })).json.pageId };
else await call('set_current_page', { pageId: page.id });
const pageId = page.id ?? page.pageId;

// Clear what an earlier run drew here, so running it again redraws it.
const existing = (await call('get_board', { pageId })).json.items.map((i) => i.id);

const mermaid = `flowchart TD
  start([User opens the app]) --> sess{Valid session?}
  sess -- yes --> resume([Continue to the app])
  sess -- no --> login[Sign-in screen]
  login --> method{Sign-in method}

  method -->|Email and password| creds[Enter email and password]
  method -->|Google or Apple| oauth[Redirect to identity provider]
  method -->|Work SSO| sso[Find IdP by email domain]
  method -->|Magic link| magic[Send one-time sign-in link]
  method -->|No account yet| signup[Create account form]
  login --> forgot[Forgot password]

  subgraph Password sign-in
    creds --> rate{Too many attempts?}
    rate -- yes --> locked[Lock account for 15 minutes]
    rate -- no --> check{Credentials valid?}
    check -- no --> err[Show error and count the attempt]
    err -.-> creds
  end

  subgraph Social and SSO
    oauth --> consent[Provider consent screen]
    consent --> token{ID token verified?}
    token -- yes --> exists{Account exists?}
    exists -- no --> provision[Create account from profile]
    sso --> idp[Company IdP sign-in]
    idp --> assertion{SAML assertion valid?}
  end
  token -- no --> fail[Sign-in failed]
  assertion -- no --> fail

  subgraph Magic link
    magic --> inbox[User opens the email]
    inbox --> expired{Link still valid?}
    expired -- no --> magic
  end

  check -- yes --> mfa{MFA enabled?}
  exists -- yes --> mfa
  provision --> mfa
  assertion -- yes --> mfa
  expired -- yes --> mfa

  subgraph Multi-factor
    mfa -- yes --> factor{Second factor}
    factor -->|Authenticator app| totp[Enter app code]
    factor -->|SMS| sms[Text a 6-digit code]
    factor -->|Lost device| backup[Enter a backup code]
    totp --> codeok{Code valid?}
    sms --> codeok
    backup --> codeok
    codeok -- no --> retry[Show error, allow 5 tries]
    retry -.-> factor
    codeok -- yes --> trust{Trust this device?}
    trust -- yes --> remember[Remember device for 30 days]
    trust -- no --> ask[Ask again next sign-in]
  end

  subgraph Sign up
    signup --> strength{Password strong enough?}
    strength -- no --> signup
    strength -- yes --> verify[Send verification email]
    verify --> verified{Verified within 24 hours?}
    verified -- no --> resend[Resend verification]
    resend -.-> verified
  end

  subgraph Recovery
    forgot --> reset[Send reset link]
    reset --> newpw[Set a new password]
    newpw --> revoke[Sign out other sessions]
  end
  revoke --> login

  mfa -- no --> issue[Issue session and refresh token]
  remember --> issue
  ask --> issue
  verified -- yes --> issue
  issue --> home((App home))`;

const drawn = await call('write_diagram', {
  pageId, mermaid, replace: existing, x: 0, y: 120,
  colors: {
    start: 'slate', home: 'green', resume: 'green', issue: 'green',
    locked: 'red', err: 'red', fail: 'red', retry: 'red',
    magic: 'slate', verify: 'slate', reset: 'slate', sms: 'slate', provision: 'slate', revoke: 'slate', remember: 'slate',
  },
});
const d = drawn.json;
if (d.skipped) console.log('skipped:', JSON.stringify(d.skipped));
if (d.problems) console.log('problems:', JSON.stringify(d.problems));

// One route by hand: sign-up's way into a session runs down the left and
// along the bottom, rather than straight across the multi-factor block.
const board = (await call('get_board', { pageId })).json.items;
const signupDone = board.find((i) => i.type === 'connector' && i.from.id === d.shapes.verified && i.to.id === d.shapes.issue);
const noMfa = board.find((i) => i.type === 'connector' && i.from.id === d.shapes.mfa && i.to.id === d.shapes.issue);
await call('edit_board', { pageId, changes: [
  ...(signupDone ? [{ action: 'update', id: signupDone.id, patch: { fromSide: 'bottom', toSide: 'left' } }] : []),
  // No MFA goes straight to a session: down the left of the block, not through it.
  ...(noMfa ? [{ action: 'update', id: noMfa.id, patch: { fromSide: 'left', toSide: 'left' } }] : []),
] });

// A title over it, the way a flow sheet is headed.
const b = d.bounds;
const titled = await call('edit_board', { pageId, changes: [
  { action: 'add', shape: { kind: 'text', x: b.x, y: b.y - 110, width: 900, height: 44, text: 'Authentication flow' } },
  { action: 'add', shape: { kind: 'text', x: b.x, y: b.y - 66, width: 1100, height: 30,
    text: 'Password, social, SSO and magic-link sign-in; multi-factor; sign-up with verification; password recovery.' } },
] });
// Headings are bigger than body text: the title in the display size.
const [title, sub] = titled.json.added;
await call('edit_board', { pageId, changes: [
  { action: 'update', id: title, patch: { height: 44 } },
] });

const pic = await call('get_board', { pageId, image: true });
const img = pic.raw.content.find((c) => c.type === 'image');
if (img) writeFileSync('/tmp/auth-flow.png', Buffer.from(img.data, 'base64'));
console.log(`${d.ids.length} items · ${Math.round(b.width)}×${Math.round(b.height)} · page ${pageId}`);
await client.close();
