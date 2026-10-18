/**
 * The Hono application: REST API, asset serving, MCP endpoint, static client.
 *
 * Deliberately free of side effects so tests can mount it on their own port —
 * starting a listener lives in index.ts.
 */

import { gatherHealthFacts } from './health.ts';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emitHtml, emitJsx, emitStandalone, parseHtml, makeNode,
  DEFAULT_ARTBOARD_STYLES, type CanvasDocument, getNode,
} from '@playground/shared';
import {
  applyOps, createDocument, deleteDocument, ensureLoaded, getDocument, getSnapshot, history,
  listDocuments, createSnapshot, listSnapshots, opsSince, restoreSnapshot, touchDocument, StoreError,
} from './store.ts';
import { peersOf, hasLiveTab } from './realtime.ts';
import {
  ConnectionError, type ConnectionOptions, createConnection, createProjectConnection, listConnections, projectDocuments, resolveConnection, revokeConnection,
  type Connection,
  createAccountConnection, listAccountConnections, accountOf, parseLinkScope,
} from './connections.ts';
import { handleMcpRequest } from './mcp.ts';
import { getAsset, storeAsset, AssetError, MAX_ASSET_BYTES } from './assets.ts';
import { importImage, ImageImportError } from './image-import.ts';
import {
  type Share, createShare, listShares, redactForViewer, resolveShare, revokeShare, viewerMayApply,
} from './shares.ts';
import {
  ProjectError, createProject, deleteProject, fileDocument, listProjects, renameProject,
} from './projects.ts';
import {
  type BundleAsset, type DocumentBundle,
  BUNDLE_FORMAT, diffDocuments, newId, referencedAssets, remapAssets, stripLocalState, validateBundle,
} from '@playground/shared';
import { importUrl, ImportError } from './import.ts';
import { freeSlug, pageArtboard, publishedHtml, slugify } from './publish.ts';
import {
  handoffAllows, handoffHtml, handoffScreenHtml, listHandoffs, publishHandoff, resolveHandoff, unpublishHandoff,
  type HandoffScope,
} from './handoff.ts';
import { getTemplate, templateSummaries, type Template } from './templates.ts';
import { DEFAULT_STYLE, getStarter, starterHtml, starterSummaries, STARTERS } from './starters.ts';
import { RENDERER_VERSION, renderNode, renderThumbnail } from './render.ts';
import { persistence, type MemberRole } from './persistence.ts';
import {
  AuthError, SESSION_COOKIE, atLeast, authenticate, createAccount, documentsFor, endSession, grant,
  acceptInvite, createInvite, hasAccounts, invitesFor, membersOf, publicUser, readInvite,
  revokeInvite, revokeMembership, roleFor, signupCodeRequired, startSession,
} from './accounts.ts';
import { DB_PATH } from './persistence-sqlite.ts';
import { idUrl, userFromCookies } from './sso.ts';
import { connect } from './connect.ts';
import { isOnMountedVolume } from './volume.ts';
import { dirname } from 'node:path';
import { APP_CSP, clientIp, rateLimit, securityHeaders } from './security.ts';
import { bodyLimit } from 'hono/body-limit';
import {
  LiveError, answerPageHtml, boardHtml, castLiveVote, clearLiveAnswers, createLiveQuestion, deviceFor, deviceView,
  getLiveQuestion, hideLiveAnswer, likeLiveAnswer, moderatorView, liveQuestionsInOrder, answersCsv, controlPageHtml, submitLiveAnswer, updateLiveQuestion, waitForBoardState,
} from './live.ts';

const PORT = Number(process.env.PORT ?? 4000);
const PUBLIC_URL =
  (process.env.APP_URL ||
  process.env.PLAYGROUND_PUBLIC_URL) ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null) ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
  `http://localhost:${PORT}`;

/** On Vercel the platform serves the built client; the app only handles the API. */
const SERVE_CLIENT = !process.env.VERCEL;

const app = new Hono();

/**
 * Old addresses (REDIRECT_HOSTS, comma-separated) send page loads on to
 * APP_URL (or the older PLAYGROUND_PUBLIC_URL), path and query kept so shared links still land. The
 * shared sign-in cookie only exists under .heymax.im, so a page opened anywhere
 * else could never be signed in. API, MCP and WebSocket calls are left alone:
 * clients configured with the old address keep working.
 */
const REDIRECT_HOSTS = (process.env.REDIRECT_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
// Never redirect to a host that is itself being redirected: that is a loop.
if (REDIRECT_HOSTS.length && !REDIRECT_HOSTS.includes(new URL(PUBLIC_URL).hostname.toLowerCase())) {
  app.use('*', async (c, next) => {
    const host = (c.req.header('x-forwarded-host') ?? c.req.header('host') ?? '').split(':')[0]!.toLowerCase();
    const isPage = (c.req.method === 'GET' || c.req.method === 'HEAD') && !/^\/(api|mcp|ws)(\/|$)/.test(c.req.path)
      && c.req.header('upgrade') === undefined;
    if (!REDIRECT_HOSTS.includes(host) || !isPage) return next();
    const url = new URL(c.req.url);
    return c.redirect(`${PUBLIC_URL}${url.pathname}${url.search}`, 301);
  });
}

/**
 * Assets are fetched by code-component sandboxes, which have an opaque origin,
 * so their requests carry `Origin: null`. The general CORS policy echoes the
 * origin back with credentials enabled, and a browser refuses that pairing for
 * a null origin — the module import fails with a bare "failed to fetch".
 *
 * Assets are public to anyone holding the id and are never credentialed, so
 * this route answers with a plain wildcard instead. Registered before the CORS
 * middleware so that its post-response code runs last and wins.
 */
app.use('/assets/*', async (c, next) => {
  await next();
  c.res.headers.set('Access-Control-Allow-Origin', '*');
  c.res.headers.delete('Access-Control-Allow-Credentials');
});

app.use('*', cors({ origin: (o) => o ?? '*', credentials: true }));
app.use('*', securityHeaders);

/*
 * Per-IP limits on everything reachable without an account. Sign-in and
 * sign-up are the brute-force targets and get the tightest bucket; share and
 * invite tokens are long enough not to be guessed, so theirs only stops floods.
 */
const SMALL_BODY = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'Request body too large.' }, 413) });
app.use('/api/auth/*', rateLimit({ name: 'auth', limit: 10, windowMs: 60_000 }), SMALL_BODY);
app.use('/api/invites/*', rateLimit({ name: 'invites', limit: 30, windowMs: 60_000 }), SMALL_BODY);
app.use('/api/shares/*', rateLimit({ name: 'shares', limit: 120, windowMs: 60_000 }),
  bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large.' }, 413) }));
app.use('/api/connect/*', rateLimit({ name: 'connect', limit: 120, windowMs: 60_000 }));
app.use('/mcp/*', rateLimit({ name: 'mcp', limit: 600, windowMs: 60_000 }));
// Answers carry their own per-client limit (live.ts); this only caps the body.
app.use('/q/*', bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ error: 'Request body too large.' }, 413) }));

/**
 * Turns an unhandled failure into something the caller can act on.
 *
 * Storage is the one that matters. When the Blob store is unavailable — a
 * suspended store, an expired token, a billing state gone inactive — every
 * write throws from deep inside persistence, and the bare 500 that produced
 * said nothing at all. An agent or a browser hitting that deserves to be told
 * which of "the server is broken" and "the storage behind it is switched off"
 * it is looking at, because only one of them is worth retrying.
 */
app.onError((err, c) => {
  const message = err instanceof Error ? err.message : String(err);
  // A rejected sign-up or sign-in is the caller's problem to fix and says so;
  // it is not a server fault and must not be logged as one.
  if (err instanceof AuthError) return c.json({ error: message }, err.status as 400);
  const storage = /blob|suspended|store|token|quota|billing/i.test(message);
  if (storage) {
    console.error('[playground] storage failure:', message);
    return c.json({
      error: 'The storage behind this deployment is unavailable, so nothing can be saved right now.',
      detail: message,
      hint: 'Reads from the cache may still work. Check the Blob store\'s status and billing state.',
    }, 503);
  }
  console.error('[playground] unhandled:', err);
  return c.json({ error: message }, 500);
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

type Vars = { user: import('./persistence.ts').StoredUser | null; role: MemberRole | null };
const api = new Hono<{ Variables: Vars }>();

/**
 * Paths that work without an account.
 *
 * `/shares/*` is not an exception to access control — a share token *is* the
 * credential, and the share layer already refuses edits from a view-only one.
 */
const PUBLIC_PATHS = [
  /^\/health$/, /^\/auth(\/|$)/, /^\/shares(\/|$)/,
  // An invitee is not a member yet; the invite token is what they have.
  /^\/invites(\/|$)/,
];

/** Paths where being an editor is not enough. */
const OWNER_ONLY: { method: string; pattern: RegExp }[] = [
  { method: 'DELETE', pattern: /^\/documents\/[^/]+$/ },
  { method: 'POST', pattern: /^\/documents\/[^/]+\/members$/ },
  { method: 'POST', pattern: /^\/documents\/[^/]+\/invites$/ },
  { method: 'DELETE', pattern: /^\/documents\/[^/]+\/invites\/[^/]+$/ },
  { method: 'DELETE', pattern: /^\/documents\/[^/]+\/members\/[^/]+$/ },
  { method: 'POST', pattern: /^\/documents\/[^/]+\/shares$/ },
  { method: 'POST', pattern: /^\/documents\/[^/]+\/publish$/ },
  { method: 'DELETE', pattern: /^\/documents\/[^/]+\/publish$/ },
  { method: 'POST', pattern: /^\/documents\/[^/]+\/handoffs$/ },
  { method: 'DELETE', pattern: /^\/documents\/[^/]+\/handoffs(\/[^/]+)?$/ },
  { method: 'DELETE', pattern: /^\/shares\/[^/]+$/ },
];

/**
 * One gate in front of the whole API.
 *
 * Per-route checks were the alternative, and the failure mode there is a route
 * added later that quietly has none — which is exactly the state this instance
 * was in before accounts: every document readable and writable by anyone who
 * knew the URL.
 *
 * A document nobody is a member of is reachable by any signed-in user. That is
 * the state of a fresh instance with no accounts yet, and of anything created
 * before this existed; the first account claims all of it at sign-up.
 */
api.use('*', async (c, next) => {
  const path = c.req.path.replace(/^\/api/, '') || '/';
  const user = await userFromCookies(c.req.header('cookie'));
  c.set('user', user);
  c.set('role', null);

  if (PUBLIC_PATHS.some((p) => p.test(path))) return next();
  if (!user) return c.json({ error: 'Sign in to continue.', needsAuth: true }, 401);

  const docId = await documentIdFor(c.req.method, path);
  if (!docId) return next();

  // An unknown document is a 404 to a member and a 404 to everyone else: a
  // "you may not" on an id that exists tells a stranger it exists.
  const role = await roleFor(docId, user.id);
  const memberships = await (await persistence()).loadMemberships({ docId });
  const unowned = memberships.length === 0;
  if (!role && !unowned) return c.json({ error: 'You do not have access to this document.' }, 404);
  c.set('role', role ?? 'owner');

  const needed: MemberRole =
    OWNER_ONLY.some((r) => r.method === c.req.method && r.pattern.test(path)) ? 'owner'
      : c.req.method === 'GET' ? 'viewer'
        : 'editor';
  if (!unowned && !atLeast(role, needed)) {
    return c.json({ error: `This document is ${role === 'viewer' ? 'view-only for you' : 'not yours to change'}.` }, 403);
  }
  return next();
});

/**
 * The document a request acts on, or null when it acts on none.
 *
 * `/documents/import` is the trap: it looks exactly like `/documents/:id` and
 * the id it would yield is the word "import".
 */
async function documentIdFor(method: string, path: string): Promise<string | null> {
  const seg = path.split('/').filter(Boolean);
  if (seg[0] === 'documents' && seg[1] && seg[1] !== 'import') return seg[1];
  // Moderating a live question names its code; the gate needs its document.
  if (seg[0] === 'live' && seg[1]) return (await getLiveQuestion(seg[1]))?.docId ?? null;
  // Revoking a connection names the code, not the document it belongs to.
  if (seg[0] === 'connections' && seg[1] && method === 'DELETE') {
    const conn = await (await persistence()).loadConnection(seg[1]);
    return conn?.docId ?? null;
  }
  return null;
}

/**
 * Health, plus the two settings that are wrong most often on a fresh deploy.
 *
 * Both are things a caller can already observe — the public URL is in every
 * link the server hands out, and the storage kind is obvious from behaviour —
 * so reporting them leaks nothing and saves digging through container logs to
 * find out whether an environment variable actually arrived.
 */
api.get('/health', async (c) => {
  const store = await persistence();
  return c.json({
    ok: true,
    version: '0.1.0',
    publicUrl: PUBLIC_URL,
    publicUrlConfigured: !!(process.env.APP_URL || process.env.PLAYGROUND_PUBLIC_URL),
    storage: store.kind,
    ...(store.kind === 'sqlite' ? {
      database: DB_PATH,
      // null where it cannot be determined — anywhere without /proc. False is
      // the one worth acting on: the data is in the container layer and the
      // next redeploy will take it.
      databaseOnVolume: isOnMountedVolume(dirname(DB_PATH)),
    } : {}),
  });
});

// --- Accounts ---------------------------------------------------------------

/**
 * Whether this instance has any accounts, which is all a signed-out visitor is
 * told. An empty instance offers to create the first account; one with accounts
 * offers to sign in, and says nothing about who is on it.
 */
api.get('/auth/state', async (c) => c.json({
  hasAccounts: await hasAccounts(),
  signupCodeRequired: signupCodeRequired(),
  // Set when sign-in happens at the family's identity service instead of here.
  idUrl,
  user: c.get('user') ? publicUser(c.get('user')!) : null,
}));

api.get('/auth/me', async (c) => {
  const user = c.get('user');
  return user ? c.json({ user: publicUser(user) }) : c.json({ user: null }, 401);
});

// Under single sign-on there is no local password form, so no local sign-in.
api.post('/auth/signup', async (c, next) => (idUrl ? c.json({ error: 'Sign in at the identity service.' }, 404) : next()));
api.post('/auth/login', async (c, next) => (idUrl ? c.json({ error: 'Sign in at the identity service.' }, 404) : next()));

api.post('/auth/signup', async (c) => {
  const { email, password, name, code } =
    await c.req.json<{ email?: string; password?: string; name?: string; code?: string }>();
  const { user, claimed } = await createAccount(String(email ?? ''), String(password ?? ''), name, code);
  await issueSession(c, user.id);
  return c.json({ user: publicUser(user), claimed }, 201);
});

api.post('/auth/login', async (c) => {
  const { email, password } = await c.req.json<{ email?: string; password?: string }>();
  const user = await authenticate(String(email ?? ''), String(password ?? ''));
  await issueSession(c, user.id);
  return c.json({ user: publicUser(user) });
});

api.post('/auth/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await endSession(token);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

/** Members of one document, and the calling user's own role in it. */
api.get('/documents/:id/members', async (c) => c.json({
  members: await membersOf(c.req.param('id')),
  role: c.get('role'),
}));

/**
 * Invitations to a document.
 *
 * A link, not an email: this instance has no mail service, so the owner is the
 * one who sends it. Naming an address is optional and only narrows who the link
 * works for.
 */
api.get('/documents/:id/invites', async (c) => c.json({
  invites: (await invitesFor(c.req.param('id')))
    .filter((i) => !i.revoked && !i.accepted)
    .map((i) => ({ ...i, url: `${PUBLIC_URL}/join/${i.token}` })),
}));

api.post('/documents/:id/invites', async (c) => {
  type InviteBody = { email?: string; role?: MemberRole };
  const { email, role } = await c.req.json<InviteBody>().catch((): InviteBody => ({}));
  const wanted: MemberRole = role === 'owner' || role === 'viewer' ? role : 'editor';
  const store = await persistence();

  // Someone who already has an account does not need a link: add them, and say
  // which of the two happened rather than pretending both are "invited".
  if (email) {
    const existing = await store.loadUserByEmail(email.trim().toLowerCase());
    if (existing) {
      await grant(c.req.param('id'), existing.id, wanted);
      return c.json({ added: publicUser(existing), members: await membersOf(c.req.param('id')) }, 201);
    }
  }

  const invite = await createInvite(c.req.param('id'), c.get('user')!.id, wanted, email);
  return c.json({ invite: { ...invite, url: `${PUBLIC_URL}/join/${invite.token}` } }, 201);
});

api.delete('/documents/:id/invites/:token', async (c) => {
  await revokeInvite(c.req.param('token'));
  return c.json({ ok: true });
});

/**
 * Reading and accepting an invitation.
 *
 * Not under `/documents/:id`, because the person following the link is not a
 * member yet — the gate would turn them away before they could accept.
 */
api.get('/invites/:token', async (c) => {
  const invite = await readInvite(c.req.param('token'));
  if (!invite) return c.json({ error: 'That invitation has been withdrawn or never existed.' }, 404);
  await ensureLoaded(invite.docId);
  const doc = getDocument(invite.docId);
  const inviter = await (await persistence()).loadUser(invite.invitedBy);
  return c.json({
    document: { id: invite.docId, name: doc?.name ?? 'a document' },
    role: invite.role,
    email: invite.email,
    invitedBy: inviter ? { name: inviter.name, email: inviter.email } : null,
    expired: invite.expiresAt < Date.now(),
    // Whether the caller can accept right now, or has to sign in first.
    signedIn: !!c.get('user'),
  });
});

api.post('/invites/:token/accept', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Sign in to accept this invitation.', needsAuth: true }, 401);
  const invite = await acceptInvite(c.req.param('token'), user);
  return c.json({ docId: invite.docId, role: invite.role, url: `${PUBLIC_URL}/d/${invite.docId}` });
});

api.post('/documents/:id/members', async (c) => {
  const { email, role } = await c.req.json<{ email?: string; role?: MemberRole }>();
  const store = await persistence();
  const invitee = await store.loadUserByEmail(String(email ?? '').trim().toLowerCase());
  // No invitation email to send yet, so an unknown address is an error rather
  // than a pending invite that would never arrive.
  if (!invitee) {
    return c.json({ error: 'No account with that address yet. Ask them to sign up first.' }, 404);
  }
  const wanted: MemberRole = role === 'owner' || role === 'viewer' ? role : 'editor';
  await grant(c.req.param('id'), invitee.id, wanted);
  return c.json({ members: await membersOf(c.req.param('id')) }, 201);
});

api.delete('/documents/:id/members/:userId', async (c) => {
  const docId = c.req.param('id');
  const userId = c.req.param('userId');
  const members = await membersOf(docId);
  // Removing the last owner leaves a document nobody can administer, which on
  // this model also means one any signed-in user can take over.
  if (members.filter((m) => m.role === 'owner').length === 1
    && members.find((m) => m.user.id === userId)?.role === 'owner') {
    return c.json({ error: 'A document needs an owner. Make someone else an owner first.' }, 400);
  }
  await revokeMembership(docId, userId);
  return c.json({ members: await membersOf(docId) });
});

/**
 * The library: documents this person is a member of, plus anything still
 * unowned. Ordering comes from the store, so the newest is first either way.
 */
api.get('/documents', async (c) => {
  const user = c.get('user')!;
  const mine = await documentsFor(user.id);
  const owned = new Set((await (await persistence()).loadMemberships({})).map((m) => m.docId));
  const store = await persistence();
  const visible = (await listDocuments()).filter((d) => mine.has(d.id) || !owned.has(d.id));
  // Whether each is live as a web page, so the library can say so at a glance.
  const published = await Promise.all(visible.map((d) => store.loadPublicationFor(d.id).then(Boolean, () => false)));
  const documents = visible.map((d, i) => ({ ...d, role: mine.get(d.id) ?? 'owner', published: published[i] }));
  return c.json({ documents });
});

api.get('/templates', (c) => c.json({ templates: templateSummaries() }));
api.get('/starters', (c) => c.json({ starters: starterSummaries(c.req.query('style') || DEFAULT_STYLE) }));

api.post('/documents', async (c) => {
  type NewDoc = { name?: string; html?: string; template?: string; starter?: string; projectId?: string; width?: number; height?: number };
  const body = await c.req.json<NewDoc>().catch(() => ({} as NewDoc));

  const template = body.template ? getTemplate(body.template) : undefined;
  if (body.template && !template) {
    return c.json({ error: `No template "${body.template}". Available: ${templateSummaries().map((t) => t.id).join(', ')}` }, 400);
  }

  const starter = body.starter ? getStarter(body.starter) : undefined;
  if (body.starter && !starter) {
    return c.json({ error: `No starter "${body.starter}". Available: ${STARTERS.map((s) => s.id).join(', ')}` }, 400);
  }

  const doc = await createDocument(body.name?.trim() || starter?.name || template?.name || 'Untitled');
  // Whoever creates it owns it. Without this the creator is a member of nothing
  // and the document is one of the "unowned" ones any signed-in user can open.
  await grant(doc.id, c.get('user')!.id, 'owner');

  // Filed at creation, so "new document in this project" is one call rather
  // than a create followed by a move that can half-fail.
  if (body.projectId) {
    try { await fileDocument(doc.id, body.projectId); }
    catch (err) { return c.json({ error: err instanceof ProjectError ? err.message : String(err) }, 400); }
  }
  // A brand new document has only the seeded defaults, and the kit is the whole
  // point of choosing it — so it replaces them outright rather than losing every
  // colour to a name collision.
  // A starter is a page, so it fills the document's first frame — opening on
  // an empty frame is the thing it exists to avoid. Its kit brings tokens only;
  // the foundations sheet is for people who asked for a design system.
  if (starter) {
    const kit = template ?? getTemplate(DEFAULT_STYLE)!;
    applyTemplate(doc.id, kit, { replaceTokens: true, tokensOnly: true });
    const artboard = doc.pages[0]!.artboards[0]!;
    applyOps(doc.id, [
      { op: { t: 'rename', updates: [{ id: artboard, name: starter.name }] }, origin: { kind: 'system', id: 'starter' } },
      { op: { t: 'styles', updates: [{ id: artboard, styles: { width: '1440px', height: `${starter.height}px` } }] }, origin: { kind: 'system', id: 'starter' } },
      { op: { t: 'insert', nodes: parseHtml(starterHtml(starter, kit.id)).nodes, parent: artboard, index: 0 }, origin: { kind: 'system', id: 'starter', label: starter.name } },
    ]);
  } else if (template) applyTemplate(doc.id, template, { replaceTokens: true });

  // Seeding from HTML at creation time is what makes fully headless agent
  // sessions practical: create a document with content in one call.
  // Sized to the content when the caller knows it — Artifactory's "Open in
  // Playground" sends an artifact that is often far wider than a laptop screen.
  const size = (v: unknown) => (typeof v === 'number' && v >= 16 && v <= 20000 ? `${Math.round(v)}px` : undefined);
  const width = size(body.width), height = size(body.height);
  if (width || height) {
    const artboardId = doc.pages[0]!.artboards[0]!;
    const styles = { ...(width && { width }), ...(height && { height }) };
    applyOps(doc.id, [{ op: { t: 'styles', updates: [{ id: artboardId, styles }] }, origin: { kind: 'system', id: 'seed' } }]);
  }
  if (body.html) {
    const parsed = parseHtml(body.html);
    if (parsed.nodes.length) {
      const artboard = doc.pages[0]!.artboards[0]!;
      applyOps(doc.id, [{
        op: { t: 'insert', nodes: parsed.nodes, parent: artboard, index: 0 },
        origin: { kind: 'system', id: 'seed' },
      }]);
    }
  }
  return c.json({ document: getDocument(doc.id), url: `${PUBLIC_URL}/d/${doc.id}` }, 201);
});

api.post('/documents/:id/template', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const body = await c.req.json<{ template: string; replaceTokens?: boolean }>();
  const template = getTemplate(body.template);
  if (!template) return c.json({ error: `No template "${body.template}"` }, 400);
  const result = applyTemplate(doc.id, template, { replaceTokens: body.replaceTokens === true });
  return c.json({ applied: template.id, ...result }, 201);
});

/**
 * Applies a starter kit.
 *
 * `replaceTokens` decides who wins a name collision. On a new document the kit
 * should win, or every colour it defines is shadowed by the seeded defaults and
 * the kit renders in the wrong palette. On an existing document the document
 * wins, because its tokens are real work.
 */
function applyTemplate(
  docId: string,
  template: Template,
  opts: { replaceTokens?: boolean; tokensOnly?: boolean } = {},
): { artboards: string[]; tokensAdded: string[]; tokensSkipped: string[] } {
  const doc = getDocument(docId)!;
  const page = doc.pages[0]!;

  const existing = new Map(doc.tokens.map((t) => [t.name, t]));
  const tokensAdded: string[] = [];
  const tokensSkipped: string[] = [];

  for (const token of template.tokens) {
    if (existing.has(token.name) && !opts.replaceTokens) { tokensSkipped.push(token.name); continue; }
    existing.set(token.name, token);
    tokensAdded.push(token.name);
  }

  applyOps(docId, [{ op: { t: 'tokens', tokens: [...existing.values()] }, origin: { kind: 'system', id: 'template' } }]);

  const created: string[] = [];
  for (const spec of opts.tokensOnly ? [] : template.artboards) {
    const artboard = makeNode({
      type: 'artboard',
      name: `${template.name} — ${spec.name}`,
      styles: { ...DEFAULT_ARTBOARD_STYLES, ...spec.styles, width: `${spec.width}px`, height: `${spec.height}px` },
      attrs: { 'data-x': String(nextX(getDocument(docId)!, page.artboards)), 'data-y': '0' },
    });
    applyOps(docId, [{
      op: { t: 'insert', nodes: [artboard], parent: null, index: page.artboards.length, page: page.id },
      origin: { kind: 'system', id: 'template' },
    }]);

    const parsed = parseHtml(spec.html);
    applyOps(docId, [{
      op: { t: 'insert', nodes: parsed.nodes, parent: artboard.id, index: 0 },
      origin: { kind: 'system', id: 'template', label: `${template.name} kit` },
    }]);
    created.push(artboard.id);
  }
  return { artboards: created, tokensAdded, tokensSkipped };
}

api.get('/documents/:id', async (c) => {
  await ensureLoaded(c.req.param('id'));
  const doc = getDocument(c.req.param('id'));
  if (!doc) return c.json({ error: 'not found' }, 404);
  return c.json({ document: doc, peers: peersOf(doc.id), liveTabConnected: hasLiveTab(doc.id) });
});

/**
 * Polling transport, for runtimes without WebSockets (Vercel functions).
 * Returns the ops after `rev`, or the whole document when the caller is further
 * behind than the op log reaches.
 */
api.get('/documents/:id/sync', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const since = Number(c.req.query('rev') ?? 0);
  const ops = opsSince(doc.id, since);
  if (ops === null) return c.json({ resync: true, document: doc, rev: doc.rev });
  return c.json({ ops, rev: doc.rev, peers: peersOf(doc.id) });
});

api.delete('/documents/:id', async (c) =>
  (await deleteDocument(c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404));

api.post('/documents/:id/ops', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const body = await c.req.json<{ ops: Parameters<typeof applyOps>[1] }>();
  const applied = applyOps(doc.id, body.ops);
  return c.json({ rev: doc.rev, applied: applied.length });
});

api.get('/documents/:id/history', async (c) =>
  c.json({ history: history((await requireDocument(c.req.param('id'))).id) }));

api.get('/documents/:id/snapshots', async (c) =>
  c.json({ snapshots: await listSnapshots((await requireDocument(c.req.param('id'))).id) }));

api.post('/documents/:id/snapshots', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const body = await c.req.json<{ label?: string }>().catch(() => ({} as { label?: string }));
  return c.json(await createSnapshot(doc.id, body.label), 201);
});

api.post('/documents/:id/snapshots/:snapshotId/restore', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  return c.json({ document: await restoreSnapshot(doc.id, c.req.param('snapshotId')) });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * What has changed since a checkpoint.
 *
 * `since` is a snapshot id. The comparison is document-to-document rather than
 * a replay of the op log: a value nudged four times and put back is four log
 * entries and no change worth anyone's attention, and a developer wants the
 * difference from what they built against, not the history of how it got here.
 */
api.get('/documents/:id/changes', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const since = c.req.query('since');
  if (!since) return c.json({ error: 'Pass ?since=<snapshotId>. /snapshots lists them.' }, 400);

  const snapshot = await getSnapshot(doc.id, since);
  if (!snapshot) return c.json({ error: `No snapshot ${since} on this document.` }, 404);

  const diff = diffDocuments(snapshot.data, doc);
  return c.json({
    since: { id: snapshot.id, label: snapshot.label, rev: snapshot.rev, ts: snapshot.ts },
    now: { rev: doc.rev },
    ...diff,
  });
});

api.get('/documents/:id/export/:nodeId', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const nodeId = c.req.param('nodeId');
  if (!getNode(doc, nodeId)) return c.json({ error: `node ${nodeId} not found` }, 404);

  const format = (c.req.query('format') ?? 'html') as string;
  const scale = Number(c.req.query('scale') ?? 2);

  if (format === 'jsx') {
    const code = emitJsx(doc, nodeId, {
      format: (c.req.query('jsxFormat') as 'tailwind' | 'inline') ?? 'tailwind',
      componentName: c.req.query('componentName') ?? undefined,
    });
    return c.text(code, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  if (format === 'css') {
    const { css } = emitHtml(doc, nodeId, { mode: 'stylesheet' });
    return c.text(css, 200, { 'Content-Type': 'text/css; charset=utf-8' });
  }
  if (format === 'html') {
    return c.html(emitStandalone(doc, nodeId));
  }

  const { data, mime } = await renderNode(doc, nodeId, {
    format: format as 'png' | 'jpg' | 'webp' | 'svg', scale, baseUrl: PUBLIC_URL,
  });
  const name = (getNode(doc, nodeId)?.name ?? 'export').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return c.body(new Uint8Array(data), 200, {
    'Content-Type': mime,
    'Content-Disposition': `attachment; filename="${name}.${format}"`,
  });
});

api.post('/documents/:id/import', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const body = await c.req.json<{ url: string; artboardId?: string; pageId?: string }>();
  const result = await importUrl(body.url);

  const page = doc.pages.find((p) => p.id === body.pageId) ?? doc.pages[0]!;
  let artboardId = body.artboardId;

  if (!artboardId) {
    // A fresh artboard, sized to a desktop viewport, keeps the import from
    // landing inside unrelated work.
    const artboard = makeNode({
      type: 'artboard',
      name: result.title.slice(0, 40),
      styles: { ...DEFAULT_ARTBOARD_STYLES, width: '1440px', height: '1200px', overflow: 'hidden' },
      attrs: { 'data-x': String(nextX(doc, page.artboards)), 'data-y': '0' },
    });
    applyOps(doc.id, [{
      op: { t: 'insert', nodes: [artboard], parent: null, index: page.artboards.length, page: page.id },
      origin: { kind: 'system', id: 'import' },
    }]);
    artboardId = artboard.id;
  }

  applyOps(doc.id, [{
    op: { t: 'insert', nodes: result.nodes, parent: artboardId, index: 0 },
    origin: { kind: 'system', id: 'import', label: `Import ${result.url}` },
  }]);

  return c.json({
    artboardId,
    nodeCount: result.nodes.length,
    title: result.title,
    warnings: result.warnings,
  }, 201);
});

function nextX(doc: CanvasDocument, artboards: string[]): number {
  let maxRight = 0;
  for (const id of artboards) {
    const node = doc.nodes[id];
    if (!node) continue;
    maxRight = Math.max(maxRight, Number(node.attrs['data-x'] ?? 0) + (parseFloat(node.styles.width ?? '1440') || 1440));
  }
  return artboards.length ? maxRight + 120 : 0;
}

// ---------------------------------------------------------------------------
// Agent connections
// ---------------------------------------------------------------------------

api.get('/documents/:id/connections', async (c) =>
  c.json({ connections: await listConnections((await requireDocument(c.req.param('id'))).id) }));

type ConnectionBody = {
  label?: string; docId?: string;
  /** Epoch ms or an ISO date. */
  expiresAt?: number | string | null;
  /** Shorthand: hours from now. */
  expiresInHours?: number;
  readOnly?: boolean;
  /** 'document' (default), 'project' (project route only) or 'sections' with sectionIds. */
  scope?: 'document' | 'project' | 'sections';
  sectionIds?: string[];
};

const DEFAULT_LINK_HOURS = 168;

function connectionOptions(body: ConnectionBody): ConnectionOptions {
  // Links expire after a week unless the caller says otherwise; `expiresAt: null` means never.
  let expiresAt: number | null = Date.now() + DEFAULT_LINK_HOURS * 3_600_000;
  if (body.expiresAt === null) expiresAt = null;
  else if (body.expiresInHours !== undefined) expiresAt = Date.now() + Number(body.expiresInHours) * 3_600_000;
  else if (typeof body.expiresAt === 'string') expiresAt = Date.parse(body.expiresAt);
  else if (typeof body.expiresAt === 'number') expiresAt = body.expiresAt;
  if (expiresAt !== null && Number.isNaN(expiresAt)) throw new ConnectionError('expiresAt is not a date.');
  if (body.scope === 'sections' && !body.sectionIds?.length) throw new ConnectionError('scope "sections" needs sectionIds.');
  return { expiresAt, readOnly: !!body.readOnly, sectionIds: body.sectionIds?.length ? body.sectionIds : null };
}

/**
 * Body: { label?, expiresAt? | expiresInHours?, readOnly?, scope?: 'document' | 'sections', sectionIds? }.
 * Every option is optional; without them this is the ordinary full-access link.
 */
api.post('/documents/:id/connections', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const body = await c.req.json<ConnectionBody>().catch(() => ({} as ConnectionBody));
  try {
    const conn = await createConnection(doc.id, body.label, connectionOptions(body));
    return c.json(connectionSetup(conn), 201);
  } catch (err) {
    return c.json({ error: err instanceof ConnectionError ? err.message : String(err) }, 400);
  }
});

/**
 * A connection for every document in a project. The agent starts on `docId`
 * (or the most recently changed document) and moves with switch_document.
 */
/**
 * Projects have no members of their own, so a project link is only as wide as
 * the caller's access: they must be able to `needed` every document filed in it.
 * Without this, any signed-in account could mint (or list) an agent link into
 * documents it was never invited to.
 */
async function mayUseProject(userId: string, projectId: string, needed: MemberRole): Promise<boolean> {
  const store = await persistence();
  for (const d of await projectDocuments(projectId)) {
    const unowned = (await store.loadMemberships({ docId: d.id })).length === 0;
    if (unowned) continue;
    if (!atLeast(await roleFor(d.id, userId), needed)) return false;
  }
  return true;
}

api.post('/projects/:id/connections', async (c) => {
  if (!(await mayUseProject(c.get('user')!.id, c.req.param('id'), 'editor'))) {
    return c.json({ error: 'You do not have access to every document in this project.' }, 403);
  }
  const body = await c.req.json<ConnectionBody>().catch(() => ({} as ConnectionBody));
  try {
    const conn = await createProjectConnection(c.req.param('id'), body.label, body.docId, connectionOptions(body));
    return c.json({ ...connectionSetup(conn), documents: await projectDocuments(c.req.param('id')) }, 201);
  } catch (err) {
    return c.json({ error: err instanceof ConnectionError ? err.message : String(err) }, 400);
  }
});

api.get('/projects/:id/connections', async (c) => {
  if (!(await mayUseProject(c.get('user')!.id, c.req.param('id'), 'editor'))) {
    return c.json({ error: 'You do not have access to every document in this project.' }, 403);
  }
  const store = await persistence();
  const rows = (await store.loadConnections()).filter((r) => r.projectId === c.req.param('id') && !r.revoked);
  return c.json({ connections: rows.map(({ revoked, ...rest }) => { void revoked; return rest; }) });
});

/*
 * Agent links for the signed-in account (Settings → Agents): one link covers
 * every document its owner can open, the same as the rest of the heymax family.
 * The full link is shown once, when made.
 */
api.get('/agents', async (c) => {
  return c.json({ links: await listAccountConnections(c.get('user')!.id) });
});

/**
 * Body: { label?, expiresAt?: epoch ms | ISO date | null, scope?: 'read' | 'write' }.
 * No expiry and 'write' unless asked: the link is listed and revocable in Settings.
 */
api.post('/agents', async (c) => {
  type Body = { label?: string; expiresAt?: number | string | null; scope?: unknown };
  const body = await c.req.json<Body>().catch(() => ({} as Body));
  try {
    let expiresAt: number | null = null;
    if (typeof body.expiresAt === 'string') expiresAt = Date.parse(body.expiresAt);
    else if (typeof body.expiresAt === 'number') expiresAt = body.expiresAt;
    if (expiresAt !== null && Number.isNaN(expiresAt)) throw new ConnectionError('expiresAt is not a date.');
    const conn = await createAccountConnection(c.get('user')!.id, String(body.label ?? '').trim().slice(0, 80) || 'Claude', {
      expiresAt, scope: parseLinkScope(body.scope),
    });
    return c.json(connectionSetup(conn), 201);
  } catch (err) {
    if (err instanceof ConnectionError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

api.delete('/agents/:code', async (c) => {
  const store = await persistence();
  const row = await store.loadConnection(c.req.param('code'));
  if (!row || row.revoked || accountOf(row) !== c.get('user')!.id) return c.json({ error: 'No such link.' }, 404);
  await revokeConnection(row.code);
  return c.json({ ok: true });
});

function connectionSetup(conn: Connection) {
  const url = `${PUBLIC_URL}/mcp/${conn.code}`;
  return {
    connection: conn,
    url,
    setup: {
      claudeCode: `claude mcp add playground --transport http ${url}`,
      // Codex reads ~/.codex/config.toml. `mcp-remote` bridges the hosted
      // streamable-HTTP endpoint to the stdio transport every version speaks,
      // so this works whether or not the installed build has HTTP support.
      codex: [
        'codex mcp add playground -- npx -y mcp-remote ' + url,
        '',
        '# or, by hand, in ~/.codex/config.toml:',
        '[mcp_servers.playground]',
        'command = "npx"',
        `args = ["-y", "mcp-remote", "${url}"]`,
      ].join('\n'),
      claudeDesktop: {
        mcpServers: { canvas: { command: 'npx', args: ['-y', 'mcp-remote', url] } },
      },
      cursor: { mcpServers: { canvas: { url } } },
      vscode: { servers: { canvas: { type: 'http', url } } },
    },
    expiresIn: conn.expiresAt
      ? `The link stops working at ${new Date(conn.expiresAt).toISOString()}, or if unused for 30 minutes before its first connection.`
      : 'The code stops working if unused for 30 minutes before its first connection.',
  };
}

/** Revokes this document's links not used for `unusedForDays` (default 7), and expired ones. */
api.post('/documents/:id/connections/prune', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const body = await c.req.json<{ unusedForDays?: number }>().catch(() => ({} as { unusedForDays?: number }));
  const cutoff = Date.now() - (body.unusedForDays ?? 7) * 86_400_000;
  const revoked: string[] = [];
  for (const conn of await listConnections(doc.id)) {
    const last = conn.lastUsedAt ?? conn.redeemedAt ?? conn.createdAt;
    if ((conn as { expired?: boolean }).expired || last < cutoff) {
      if (await revokeConnection(conn.code)) revoked.push(conn.code);
    }
  }
  return c.json({ revoked });
});

api.delete('/connections/:code', async (c) =>
  (await revokeConnection(c.req.param('code'))) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404));

// ---------------------------------------------------------------------------
// Whole-document export and import
// ---------------------------------------------------------------------------

/** A filename someone can find again, from a document name that may be anything. */
function bundleFilename(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'document';
}

/** Assets inline as base64, so a bundle is one file you can email or commit. */
const MAX_BUNDLE_ASSET_BYTES = 40 * 1024 * 1024;

/**
 * A picture of the document, for the library.
 *
 * Rendered from the first artboard, cached against the revision it was taken
 * at, and re-rendered when that moves. One at a time across the whole server:
 * a library of twenty documents opening at once would otherwise ask Chromium
 * for twenty pages in the same second.
 */
const THUMBNAIL = { width: 480, ratio: 16 / 10 };
/** Two sizes: the tile in the panel, and the one the hover overlay shows. */
const PREVIEW = { sm: 320, lg: 900 };
type Rendered = Awaited<ReturnType<typeof renderThumbnail>>;

/**
 * Renders at most two pictures at once.
 *
 * Unbounded, a library of twenty cards or a panel of ten components asks
 * Chromium for that many pages in the same second and every one of them gets
 * slower. Strictly one at a time was the first version and made a panel of five
 * take six seconds to fill; two halves that without the contention.
 */
const RENDER_SLOTS = 2;
let running = 0;
const waiting: (() => void)[] = [];

async function queued<T>(work: () => Promise<T>): Promise<T> {
  if (running >= RENDER_SLOTS) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/**
 * Health facts the Check tab cannot compute in the browser alone: whether each
 * font family is really on Google Fonts, which frames clip their content
 * (rendered headlessly at the frame's own size), and stylesheet coverage from
 * recent HTML imports. The tab feeds these into the same lint the MCP runs.
 */
api.get('/documents/:id/health', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const within = c.req.query('within') || undefined;
  return c.json(await queued(() => gatherHealthFacts(doc, { within, baseUrl: PUBLIC_URL })));
});

api.get('/documents/:id/thumbnail', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const store = await persistence();
  const stamp = `${RENDERER_VERSION}:cover:${doc.rev}`;
  const cached = await store.loadThumbnail(doc.id, 'doc');
  if (cached && cached.stamp === stamp) return pictureResponse(c, cached.bytes, cached.mime, stamp);

  // The busiest artboard on the first page, not the first one: a document often
  // opens with an empty starter frame beside the work, and a thumbnail of the
  // empty one is a white rectangle that says nothing.
  // A frame named "Cover", on any page, wins: it is the one meant to be seen first.
  const cover = doc.pages.flatMap((p) => p.artboards)
    .find((id) => /^cover\b/i.test(doc.nodes[id]?.name?.trim() ?? ''));
  const artboard = cover ?? (doc.pages[0]?.artboards ?? [])
    .map((id) => ({ id, size: countDescendants(doc, id) }))
    .sort((a, b) => b.size - a.size)[0]?.id;
  if (!artboard) return c.json({ error: 'This document has no artboards yet.' }, 404);

  const rendered = (await queued(() =>
    renderThumbnail(doc, artboard, { ...THUMBNAIL, baseUrl: PUBLIC_URL }))) as Rendered;

  if (!rendered) {
    if (cached) return pictureResponse(c, cached.bytes, cached.mime, cached.stamp);
    return c.json({ error: 'This server cannot render thumbnails.' }, 501);
  }
  await store.saveThumbnail({
    docId: doc.id, key: 'doc', stamp, mime: rendered.mime, bytes: rendered.data, createdAt: Date.now(),
  });
  return pictureResponse(c, rendered.data, rendered.mime, stamp);
});

/**
 * A picture of one component.
 *
 * Stamped with a hash of the definition's own subtree rather than the document
 * revision: a component's picture has to change when the component changes, and
 * must *not* be thrown away every time someone moves an unrelated layer — which
 * on a document being edited is several times a second.
 */
api.get('/documents/:id/components/:componentId/preview', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const component = doc.components?.[c.req.param('componentId')];
  if (!component) return c.json({ error: 'No such component.' }, 404);

  const size = c.req.query('size') === 'lg' ? 'lg' : 'sm';
  const key = `cmp:${component.id}:${size}`;
  const stamp = `${RENDERER_VERSION}:${subtreeStamp(doc, component.root)}`;
  const store = await persistence();
  const cached = await store.loadThumbnail(doc.id, key);
  if (cached && cached.stamp === stamp) return pictureResponse(c, cached.bytes, cached.mime, stamp);

  const rendered = (await queued(() => renderThumbnail(doc, component.root, {
    width: PREVIEW[size],
    // Components are wide and short far more often than tall, and a fixed
    // aspect box would crop a card or strand a button in white space. This asks
    // for the whole thing and lets the renderer clip only what is absurdly long.
    ratio: 1 / 3,
    baseUrl: PUBLIC_URL,
    fit: true,
  }))) as Rendered;

  if (!rendered) {
    if (cached) return pictureResponse(c, cached.bytes, cached.mime, cached.stamp);
    return c.json({ error: 'This server cannot render previews.' }, 501);
  }
  await store.saveThumbnail({
    docId: doc.id, key, stamp, mime: rendered.mime, bytes: rendered.data, createdAt: Date.now(),
  });
  return pictureResponse(c, rendered.data, rendered.mime, stamp);
});

// --- Publishing ---------------------------------------------------------------

api.get('/documents/:id/publish', async (c) => {
  const pub = await (await persistence()).loadPublicationFor(c.req.param('id'));
  return c.json({ publication: pub ? { ...pub, url: `${PUBLIC_URL}/p/${pub.slug}` } : null });
});

api.post('/documents/:id/publish', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const body = await c.req.json<{ slug?: string; artboardId?: string; description?: string }>()
    .catch(() => ({} as { slug?: string; artboardId?: string; description?: string }));

  if (body.artboardId && !doc.nodes[body.artboardId]) {
    return c.json({ error: `No artboard ${body.artboardId} in this document.` }, 400);
  }
  if (body.artboardId && !doc.nodes[body.artboardId]!.children.length) {
    return c.json({ error: 'That screen is empty — publishing it would serve a blank page.' }, 400);
  }
  if (!pageArtboard(doc, body.artboardId ?? null)) {
    return c.json({ error: 'This document has no artboards to publish yet.' }, 400);
  }

  const store = await persistence();
  const existing = await store.loadPublicationFor(doc.id);
  // Keep the slug when republishing unless a new one was asked for: the link is
  // the thing people already have.
  const slug = body.slug || existing?.slug || await freeSlug(slugify(doc.name), doc.id);
  if (body.slug && body.slug !== existing?.slug) {
    const clash = await store.loadPublication(slugify(body.slug));
    if (clash && clash.docId !== doc.id) return c.json({ error: 'That address is taken.' }, 409);
  }
  if (existing && existing.slug !== slugify(slug)) await store.deletePublication(existing.slug);

  const publication = {
    slug: slugify(slug),
    docId: doc.id,
    artboardId: body.artboardId ?? existing?.artboardId ?? null,
    title: doc.name,
    description: body.description ?? existing?.description ?? null,
    publishedBy: c.get('user')!.id,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  await store.savePublication(publication);
  return c.json({ publication: { ...publication, url: `${PUBLIC_URL}/p/${publication.slug}` } }, 201);
});

api.delete('/documents/:id/publish', async (c) => {
  const store = await persistence();
  const existing = await store.loadPublicationFor(c.req.param('id'));
  if (existing) await store.deletePublication(existing.slug);
  return c.json({ ok: true });
});

// --- Handoff sites ------------------------------------------------------------

const handoffJson = (h: Awaited<ReturnType<typeof listHandoffs>>[number]) => ({ ...h, url: `${PUBLIC_URL}/h/${h.slug}` });

api.get('/documents/:id/handoffs', async (c) => {
  return c.json({ handoffs: (await listHandoffs(c.req.param('id'))).map(handoffJson) });
});

/** Body: { scope: 'document' } or { scope: 'section', sectionId }. Same scope again returns the same link. */
api.post('/documents/:id/handoffs', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const body = await c.req.json<{ scope?: string; sectionId?: string }>().catch(() => ({} as { scope?: string; sectionId?: string }));
  const scope: HandoffScope = body.sectionId || (body.scope && body.scope !== 'document')
    ? { kind: 'section', sectionId: body.sectionId ?? body.scope! }
    : { kind: 'document' };
  try {
    return c.json({ handoff: handoffJson(await publishHandoff(doc, scope)) }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

api.delete('/documents/:id/handoffs/:slug', async (c) => {
  return c.json({ ok: true, removed: await unpublishHandoff(c.req.param('id'), c.req.param('slug')) });
});

api.delete('/documents/:id/handoffs', async (c) => {
  return c.json({ ok: true, removed: await unpublishHandoff(c.req.param('id')) });
});

api.get('/documents/:id/bundle', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const includeAssets = c.req.query('assets') !== 'false';

  const assets: BundleAsset[] = [];
  if (includeAssets) {
    let total = 0;
    for (const id of referencedAssets(doc)) {
      const asset = await getAsset(id);
      if (!asset) continue;
      total += asset.bytes.length;
      if (total > MAX_BUNDLE_ASSET_BYTES) {
        return c.json({
          error: `This document's assets exceed ${MAX_BUNDLE_ASSET_BYTES / 1e6}MB. ` +
            `Export with ?assets=false and move them separately.`,
        }, 413);
      }
      assets.push({ id, mime: asset.mime, name: asset.name, data: asset.bytes.toString('base64') });
    }
  }

  const bundle: DocumentBundle = {
    format: BUNDLE_FORMAT,
    exportedAt: new Date().toISOString(),
    source: { id: doc.id, url: `${PUBLIC_URL}/d/${doc.id}` },
    document: stripLocalState(doc),
    assets,
  };
  return c.json(bundle, 200, {
    'Content-Disposition': `attachment; filename="${bundleFilename(doc.name)}.playground.json"`,
  });
});

api.post('/documents/import', async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  const checked = validateBundle(body);
  if (!checked.ok) {
    return c.json({ error: 'That is not a document bundle this can read.', problems: checked.problems }, 400);
  }

  const { document, assets } = checked.bundle;
  const name = (c.req.query('name') ?? document.name ?? 'Imported').trim() || 'Imported';

  // Assets are stored first: their ids are unique to this instance, so the
  // document has to be pointed at the new copies before it is saved.
  const remap = new Map<string, string>();
  for (const asset of assets ?? []) {
    try {
      const stored = await storeAsset(null, asset.mime, asset.name ?? 'asset', Buffer.from(asset.data, 'base64'));
      remap.set(asset.id, stored);
    } catch (err) {
      return c.json({ error: `Asset ${asset.id} was rejected: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }
  }

  // A fresh id, always: the bundle carries the id it had where it was made, and
  // reusing it replaces that document when the two happen to be on the same
  // instance. An import creates; it never overwrites.
  const doc = await createDocument(name, { ...structuredClone(document), id: newId('doc'), name });
  await grant(doc.id, c.get('user')!.id, 'owner');
  remapAssets(doc, remap);
  if (c.req.query('projectId')) {
    try { await fileDocument(doc.id, c.req.query('projectId')!); } catch { /* an unknown project just leaves it unfiled */ }
  }
  await touchDocument(doc.id);

  return c.json({
    document: getDocument(doc.id),
    url: `${PUBLIC_URL}/d/${doc.id}`,
    assets: remap.size,
    notes: checked.problems ?? [],
  }, 201);
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

api.get('/projects', async (c) => c.json({ projects: await listProjects() }));

api.post('/projects', async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
  try {
    return c.json({ project: await createProject(body.name ?? '') }, 201);
  } catch (err) {
    return c.json({ error: err instanceof ProjectError ? err.message : String(err) }, 400);
  }
});

api.patch('/projects/:id', async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
  try {
    const project = await renameProject(c.req.param('id'), body.name ?? '');
    return project ? c.json({ project }) : c.json({ error: 'not found' }, 404);
  } catch (err) {
    return c.json({ error: err instanceof ProjectError ? err.message : String(err) }, 400);
  }
});

api.delete('/projects/:id', async (c) => {
  const { deleted, unfiled } = await deleteProject(c.req.param('id'));
  // Documents are never deleted with their project; the count is reported so
  // the UI can say where they went rather than leaving people to wonder.
  return deleted ? c.json({ ok: true, unfiled }) : c.json({ error: 'not found' }, 404);
});

api.put('/documents/:id/project', async (c) => {
  const body = await c.req.json<{ projectId?: string | null }>().catch(() => ({ projectId: null }));
  try {
    await fileDocument(c.req.param('id'), body.projectId ?? null);
    return c.json({ ok: true, projectId: body.projectId ?? null });
  } catch (err) {
    return c.json({ error: err instanceof ProjectError ? err.message : String(err) }, 404);
  }
});

// ---------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------

api.post('/documents/:id/shares', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const body = await c.req.json<{ label?: string }>().catch(() => ({} as { label?: string }));
  const share = await createShare(doc.id, body.label);
  return c.json({ share: publicShare(share), url: `${PUBLIC_URL}/s/${share.token}` }, 201);
});

api.get('/documents/:id/shares', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const shares = await listShares(doc.id);
  return c.json({
    shares: shares.map((s) => ({ ...publicShare(s), url: `${PUBLIC_URL}/s/${s.token}` })),
  });
});

api.delete('/shares/:token', async (c) =>
  (await revokeShare(c.req.param('token'))) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404));

/**
 * Everything below is what a *viewer* may call. Each is addressed by token and
 * never reveals the document id, because the id is the edit credential — a
 * viewer who learned it could simply open the editor instead.
 */
api.get('/shares/:token', async (c) => {
  const token = c.req.param('token');
  const share = await resolveShare(token);
  if (!share) return c.json({ error: 'This link has been revoked or never existed.' }, 404);
  const doc = getDocument(share.docId)!;
  return c.json({
    role: share.role,
    name: doc.name,
    document: redactForViewer(doc, token),
    rev: doc.rev,
  });
});

api.get('/shares/:token/sync', async (c) => {
  const token = c.req.param('token');
  const share = await resolveShare(token);
  if (!share) return c.json({ error: 'This link has been revoked or never existed.' }, 404);

  const doc = getDocument(share.docId)!;
  const since = Number(c.req.query('rev') ?? 0);
  const ops = opsSince(doc.id, since);
  if (ops === null) return c.json({ resync: true, document: redactForViewer(doc, token), rev: doc.rev });
  return c.json({ ops, rev: doc.rev });
});

/**
 * A viewer's only way to write.
 *
 * Serverless cannot hold a WebSocket open, so the deployed product runs viewers
 * on the polling transport — without this endpoint, commenting would work in
 * development and silently not in production.
 */
api.post('/shares/:token/ops', async (c) => {
  const share = await resolveShare(c.req.param('token'));
  if (!share) return c.json({ error: 'This link has been revoked or never existed.' }, 404);

  const body = await c.req.json<{ ops: Parameters<typeof applyOps>[1] }>().catch(() => ({ ops: [] }));
  if (!viewerMayApply(body.ops)) {
    return c.json({ error: 'A view-only link can leave comments, but not change the design.' }, 403);
  }
  const applied = applyOps(share.docId, body.ops);
  return c.json({ applied: applied.length });
});

function publicShare(s: Share) {
  // No docId: the caller minting a link already knows it, and the viewer must
  // never see it, so it is simply never part of the shape.
  return {
    token: s.token, role: s.role, label: s.label,
    createdAt: s.createdAt, lastUsedAt: s.lastUsedAt,
  };
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

api.post('/documents/:id/assets', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ error: 'expected a "file" field' }, 400);
  if (file.size > MAX_ASSET_BYTES) return c.json({ error: `file exceeds ${MAX_ASSET_BYTES / 1e6}MB` }, 413);

  const bytes = Buffer.from(await file.arrayBuffer());
  let id: string;
  try {
    id = await storeAsset(doc.id, file.type || 'application/octet-stream', file.name, bytes);
  } catch (err) {
    if (err instanceof AssetError) return c.json({ error: err.message }, 415);
    throw err;
  }
  return c.json({ id, url: `${PUBLIC_URL}/assets/${id}`, name: file.name, size: bytes.length }, 201);
});

/** A Figma paste: copy one image from Figma's signed link into the document. */
api.post('/documents/:id/assets/import', async (c) => {
  const doc = await requireDocument(c.req.param('id'));
  const body = await c.req.json().catch(() => ({})) as { url?: string; name?: string };
  if (!body.url) return c.json({ error: 'expected a "url"' }, 400);
  try {
    const { id, size } = await importImage(doc.id, body.url, body.name);
    return c.json({ id, url: `${PUBLIC_URL}/assets/${id}`, size }, 201);
  } catch (err) {
    if (err instanceof ImageImportError || err instanceof AssetError) return c.json({ error: err.message }, 422);
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Live questions — moderation. Public answering is under /q below.
// ---------------------------------------------------------------------------

/** A LiveError is the caller's to fix and says so; anything else is ours. */
function liveFailure(c: import('hono').Context, err: unknown) {
  if (err instanceof LiveError) return c.json({ error: err.message }, err.status);
  throw err;
}

api.post('/documents/:id/live', async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    question?: string; kind?: 'text' | 'poll'; options?: unknown; onePerPerson?: boolean; votable?: boolean; qr?: boolean;
  };
  try {
    const q = await createLiveQuestion(c.req.param('id'), body.question ?? '', {
      kind: body.kind, options: body.options,
      onePerPerson: typeof body.onePerPerson === 'boolean' ? body.onePerPerson : undefined,
      votable: body.votable === true,
      qr: body.qr === false ? false : undefined,
    });
    return c.json({
      code: q.code, question: q.question, kind: q.kind, url: `${PUBLIC_URL}/q/${q.code}`, board: `${PUBLIC_URL}/q/${q.code}/board`,
    }, 201);
  } catch (err) { return liveFailure(c, err); }
});

/** Every live question in a document, in slide order, for the presenter's control page. */
api.get('/documents/:id/live', async (c) => {
  if (!atLeast(c.get('role'), 'editor')) return c.json({ error: 'Only editors can moderate live questions.' }, 403);
  await ensureLoaded(c.req.param('id'));
  const doc = getDocument(c.req.param('id'));
  if (!doc) return c.json({ error: 'not found' }, 404);
  return c.json({ questions: await liveQuestionsInOrder(doc, PUBLIC_URL) });
});

/** The board's "Open controls": it knows only its code, so the server finds the page. */
api.get('/live/:code/controls', async (c) => {
  const q = await getLiveQuestion(c.req.param('code'));
  if (!q || !atLeast(c.get('role'), 'editor')) return c.json({ error: 'No such question.' }, 404);
  return c.redirect(`/d/${q.docId}/live#${q.code}`);
});

api.get('/live/:code/csv', async (c) => {
  const q = await getLiveQuestion(c.req.param('code'));
  if (!q || !atLeast(c.get('role'), 'editor')) return c.json({ error: 'No such question.' }, 404);
  return c.body(answersCsv(q), 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="live-${q.code}.csv"`,
  });
});

api.get('/live/:code', async (c) => {
  const q = await getLiveQuestion(c.req.param('code'));
  if (!q) return c.json({ error: 'No such question.' }, 404);
  return c.json({ ...moderatorView(q), canModerate: atLeast(c.get('role'), 'editor') });
});

api.patch('/live/:code', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const flag = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
  try {
    return c.json(moderatorView(await updateLiveQuestion(c.req.param('code'), {
      question: typeof body.question === 'string' ? body.question : undefined,
      open: flag(body.open), onePerPerson: flag(body.onePerPerson), votable: flag(body.votable), qr: flag(body.qr),
      options: body.options,
    })));
  } catch (err) { return liveFailure(c, err); }
});

api.post('/live/:code/answers/:answerId/hide', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { hidden?: boolean };
  try {
    const answer = await hideLiveAnswer(c.req.param('code'), c.req.param('answerId'), body.hidden !== false);
    return c.json({ id: answer.id, hidden: answer.hidden });
  } catch (err) { return liveFailure(c, err); }
});

api.post('/live/:code/clear', async (c) => {
  try {
    return c.json(await clearLiveAnswers(c.req.param('code')));
  } catch (err) { return liveFailure(c, err); }
});

// heymax connect does its own auth (session or CONNECT_TOKEN), so it is
// mounted before the API and its gate ever see the request.
app.route('/api/connect', connect);
app.route('/api', api);

/**
 * A published page.
 *
 * No account, no editor, no share token: a plain web page at a plain URL,
 * rendered from the document as it is right now.
 */
app.get('/p/:slug', async (c) => {
  // A real 404, not `c.notFound()`: this route sits in front of the SPA
  // fallback, so handing the request on served the editor shell with a 200 —
  // and an unpublished link looked like a working page that had lost its
  // content.
  const gone = () => c.html(NOT_PUBLISHED, 404);

  const store = await persistence();
  const pub = await store.loadPublication(c.req.param('slug'));
  if (!pub) return gone();

  await ensureLoaded(pub.docId);
  const doc = getDocument(pub.docId);
  if (!doc) return gone();
  const artboard = pageArtboard(doc, pub.artboardId);
  if (!artboard) return gone();

  return c.html(publishedHtml(doc, artboard, pub, `${PUBLIC_URL}/p/${pub.slug}`), 200, {
    // Short, not zero: a published link can be shared widely, and the point of
    // publishing from a design tool is that edits show up.
    'cache-control': 'public, max-age=30, stale-while-revalidate=300',
  });
});

/**
 * A live question: the answer page, the board that sits on the slide, and the
 * state the board polls. No account; the code is the whole credential, and it
 * only ever lets someone add an answer.
 */
app.get('/q/:code', async (c) => {
  const code = c.req.param('code').toLowerCase();
  const q = await getLiveQuestion(code);
  return c.html(answerPageHtml(q, code), q ? 200 : 404, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
});

/**
 * The phone behind a public request, with its cookie (re)set when needed, and
 * its token echoed so the page can keep a second copy in localStorage.
 */
function liveDevice(c: import('hono').Context, body?: Record<string, unknown>) {
  const kept = c.req.header('x-live-device') ?? (typeof body?.device === 'string' ? body.device : undefined);
  const device = deviceFor(c.req.header('cookie'), kept);
  if (device.cookie) c.header('set-cookie', device.cookie);
  return device;
}

app.get('/q/:code/me', async (c) => {
  const device = liveDevice(c);
  try {
    return c.json({ ...(await deviceView(c.req.param('code').toLowerCase(), device.id)), device: device.token }, 200, { 'cache-control': 'no-store' });
  } catch (err) { return liveFailure(c, err); }
});

app.post('/q/:code/answers', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const device = liveDevice(c, body);
  try {
    const answer = await submitLiveAnswer(c.req.param('code').toLowerCase(), body, device.id, clientIp(c) ?? 'unknown');
    return c.json({ ok: true, id: answer.id, device: device.token }, 201);
  } catch (err) { return liveFailure(c, err); }
});

app.post('/q/:code/vote', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const device = liveDevice(c, body);
  try {
    const vote = await castLiveVote(c.req.param('code').toLowerCase(), body.option, device.id, clientIp(c) ?? 'unknown');
    return c.json({ ok: true, ...vote, device: device.token }, 201);
  } catch (err) { return liveFailure(c, err); }
});

app.post('/q/:code/answers/:answerId/like', async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const device = liveDevice(c, body);
  try {
    const likes = await likeLiveAnswer(c.req.param('code').toLowerCase(), c.req.param('answerId'), body.liked !== false, device.id, clientIp(c) ?? 'unknown');
    return c.json({ ok: true, likes, device: device.token });
  } catch (err) { return liveFailure(c, err); }
});

/**
 * The presenter's control page. The shell is the same for everyone; what it
 * shows comes from the API, which refuses anyone who cannot edit the document.
 */
app.get('/d/:id/live', (c) => c.html(controlPageHtml(c.req.param('id')), 200, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' }));

/**
 * The board may be framed by anything. Its usual parent is an artboard on this
 * origin, but the screenshot renderer draws from about:blank, and a framing
 * rule refused it there — the slide came out empty. Nothing on the board acts
 * without the viewer's own signed-in, same-origin request.
 */
const BOARD_CSP = APP_CSP.split('; ').filter((d) => !d.startsWith('frame-ancestors')).join('; ');

app.get('/q/:code/board', async (c) => {
  const q = await getLiveQuestion(c.req.param('code'));
  if (!q) return c.html(answerPageHtml(null, c.req.param('code')), 404);
  const state = await waitForBoardState(q.code, -1, 0);
  return c.html(boardHtml(q, state!.v, PUBLIC_URL, {
    qr: c.req.query('qr'), font: c.req.query('font'), ink: c.req.query('ink'), accent: c.req.query('accent'), card: c.req.query('card'),
  }), 200, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'content-security-policy': BOARD_CSP });
});

app.get('/q/:code/state', async (c) => {
  const since = Number(c.req.query('v') ?? -1);
  const wait = Math.max(0, Math.min(25_000, Number(c.req.query('wait') ?? 0) || 0));
  const state = await waitForBoardState(c.req.param('code'), Number.isFinite(since) ? since : -1, wait, c.req.raw.signal);
  if (!state) return c.json({ error: 'No such question.' }, 404);
  return c.json(state, 200, { 'cache-control': 'no-store' });
});

/** A handoff site: read-only spec for a document or one section, no account. */
app.get('/h/:slug', async (c) => {
  const found = await resolveHandoff(c.req.param('slug'));
  if (!found) return c.html(NOT_PUBLISHED, 404);
  return c.html(handoffHtml(found.doc, found.handoff, `/h/${found.handoff.slug}`), 200, {
    'cache-control': 'private, max-age=15',
    'x-robots-tag': 'noindex',
  });
});

app.get('/h/:slug/screen/:id', async (c) => {
  const found = await resolveHandoff(c.req.param('slug'));
  const id = c.req.param('id');
  if (!found || !handoffAllows(found.doc, found.handoff.scope, id)) return c.html(NOT_PUBLISHED, 404);
  return c.html(handoffScreenHtml(found.doc, id), 200, { 'cache-control': 'private, max-age=15', 'x-robots-tag': 'noindex' });
});

app.get('/assets/:id', async (c) => {
  const asset = await getAsset(c.req.param('id'));
  if (!asset) return c.json({ error: 'not found' }, 404);
  return c.body(new Uint8Array(asset.bytes), 200, {
    'Content-Type': asset.mime,
    'Cache-Control': 'public, max-age=31536000, immutable',
    // Code-component bundles are imported by a sandboxed frame, which has an
    // opaque origin — every fetch from it is cross-origin, CORS included.
    // Assets are already public to anyone holding the id, so this grants
    // nothing that the URL did not.
    'Access-Control-Allow-Origin': '*',
  });
});

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

app.all('/mcp/:code', async (c) => {
  let connection: Connection | null;
  try {
    connection = await resolveConnection(c.req.param('code'));
  } catch (err) {
    if (err instanceof ConnectionError) return c.json({ error: err.message, expired: true }, 401);
    throw err;
  }
  if (!connection) {
    // Deliberately does not distinguish unknown / revoked / expired.
    return c.json({
      error: 'This connection code is not valid. Generate a new one from the Connect agent panel in Playground.',
    }, 401);
  }
  return handleMcpRequest(c.req.raw, connection, PUBLIC_URL);
});

// ---------------------------------------------------------------------------
// Web client
// ---------------------------------------------------------------------------

// Anchored to this package, not the working directory, for the same reason the
// database path is: starting the server from elsewhere should not change what
// it serves.
const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const WEB_DIST = resolve(PACKAGE_ROOT, '../web/dist');
if (SERVE_CLIENT && existsSync(WEB_DIST)) {
  // serveStatic resolves `root` against the process working directory, so hand
  // it a relative path computed from wherever the server was actually started.
  const relRoot = relative(process.cwd(), WEB_DIST) || '.';
  // Without an explicit header Cloudflare applies its own four-hour browser
  // TTL, so a deploy stayed invisible until a hard reload. The shell is
  // revalidated on every load; Vite's hashed bundles never change under the
  // same name. Routes that set their own header keep it.
  app.use('/*', async (c, next) => {
    await next();
    if (c.res.headers.has('cache-control')) return;
    if (c.req.path.startsWith('/assets/app/')) {
      // Only a real file is forever: anything else caching here would stick.
      c.res.headers.set('cache-control', c.res.status === 200 ? 'public, max-age=31536000, immutable' : 'no-store');
    } else if (c.res.headers.get('content-type')?.startsWith('text/html')) {
      c.res.headers.set('cache-control', 'no-cache');
    }
  });
  app.use('/assets/app/*', serveStatic({ root: relRoot }));
  // A bundle that is not here (a browser asking for the next build while this
  // one still serves, mid-deploy) is a 404, never the SPA shell: the shell came
  // back as text/html under an immutable bundle name, browsers cached it, and
  // the app stayed blank until the cache was cleared.
  app.get('/assets/app/*', (c) => c.text('Not found', 404, { 'cache-control': 'no-store' }));
  app.use('/*', serveStatic({ root: relRoot }));
  // The editor is a SPA: every unmatched path serves the shell so /d/:id works
  // on a hard refresh.
  const shell = serveStatic({ path: `${relative(process.cwd(), WEB_DIST) || '.'}/index.html` });
  app.get('/d/:id', shell);
  app.get('/s/:token', shell);
  app.notFound((c) => shell(c, async () => {}) as Response | Promise<Response>);
} else {
  app.get('/', (c) =>
    c.text('Playground API is running. The web client is not built — run `npm run dev:web` (Vite serves it on :5173).'));
}

/**
 * Brings a document into the synchronous cache and returns it.
 *
 * Serverless invocations start cold with an empty cache, so every route that
 * touches a document has to go through here rather than reading the cache
 * directly.
 */
/**
 * Sets the session cookie.
 *
 * `secure` follows the public URL rather than NODE_ENV: a local HTTP instance
 * would drop a secure cookie on the floor and nobody could ever sign in, and a
 * production instance behind TLS must not hand its cookie out over plain HTTP.
 */
async function issueSession(c: Context<{ Variables: Vars }>, userId: string): Promise<void> {
  const token = await startSession(userId);
  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: PUBLIC_URL.startsWith('https://'),
    maxAge: 30 * 24 * 60 * 60,
  });
}

/**
 * Thumbnails are immutable for a revision, so they are cached hard and the
 * revision is in the ETag — a document that has not changed costs a 304.
 */
function countDescendants(doc: CanvasDocument, id: string): number {
  const node = doc.nodes[id];
  if (!node) return 0;
  return 1 + node.children.reduce((n, child) => n + countDescendants(doc, child), 0);
}

/**
 * A short hash of everything about a subtree that a picture of it would show.
 *
 * Ids are included because a child being replaced changes what is drawn, but
 * nothing outside the subtree is — which is the whole point.
 */
function subtreeStamp(doc: CanvasDocument, id: string): string {
  const hash = createHash('sha1');
  const walk = (nodeId: string) => {
    const n = doc.nodes[nodeId];
    if (!n) return;
    hash.update(`${n.id}|${n.type}|${n.tag ?? ''}|${n.text ?? ''}|`);
    hash.update(JSON.stringify(n.styles));
    hash.update(JSON.stringify(n.attrs ?? {}));
    hash.update(JSON.stringify(n.variants ?? []));
    for (const child of n.children) walk(child);
  };
  walk(id);
  // Tokens resolve inside the render, so a theme edit has to invalidate it too.
  hash.update(JSON.stringify(doc.tokens ?? []));
  return hash.digest('hex').slice(0, 16);
}

function pictureResponse(c: Context<{ Variables: Vars }>, bytes: Buffer, mime: string, stamp: string) {
  const etag = `"thumb-${stamp}"`;
  if (c.req.header('if-none-match') === etag) return c.body(null, 304);
  return c.body(new Uint8Array(bytes), 200, {
    'content-type': mime,
    'cache-control': 'private, max-age=0, must-revalidate',
    etag,
  });
}

/** What an unpublished or withdrawn link shows. Deliberately plain. */
const NOT_PUBLISHED = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Not published</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.6 system-ui, sans-serif; color: #444; background: #fafafa; }
  div { max-width: 26rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.2rem; margin: 0 0 .5rem; color: #111; }
</style></head>
<body><div><h1>This page is not published</h1>
<p>The link may have been withdrawn, or it may never have existed.</p></div></body></html>`;

async function requireDocument(id: string): Promise<CanvasDocument> {
  await ensureLoaded(id);
  const doc = getDocument(id);
  if (!doc) throw new StoreError(`document ${id} not found`);
  return doc;
}

export { app, PORT, PUBLIC_URL, WEB_DIST };
