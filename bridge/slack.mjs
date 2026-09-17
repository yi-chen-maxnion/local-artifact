/**
 * Sharing a comment to Slack, as the person who left it.
 *
 * Everything here runs in the daemon rather than in the extension, because what it holds is a
 * user token: it can post anywhere its owner can. A token in the browser is a token every page
 * the browser opens is one bug away from; here it is a 0600 file in the user's config directory
 * and never leaves this process - no route returns it, and the overlay is told only whether a
 * connection exists and under whose name.
 *
 * The app is a PKCE public client, so there is no client secret to hand round a team: each
 * person runs `/slack login` once, authorises in their own browser, and the code comes back to
 * this daemon on loopback. Slack treats a `localhost` redirect as a desktop one, which is also
 * why the app asks for user scopes only - desktop redirects cannot request bot scopes.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, PORT, ROOT, rateLimiter, writeFileAtomic } from '../lib/common.mjs';
import { slackMessage } from '../lib/format.mjs';

const API = process.env.LOCAL_ARTIFACT_SLACK_API || 'https://slack.com/api';
const AUTHORIZE = process.env.LOCAL_ARTIFACT_SLACK_AUTHORIZE || 'https://slack.com/oauth/v2/authorize';
const TOKEN_FILE = path.join(CONFIG_DIR, 'slack-token.json');
const RECENT_FILE = path.join(CONFIG_DIR, 'slack-recent.json');
const REDIRECT = `http://localhost:${PORT}/slack/callback`;

/**
 * Read rather than post: the list of places a comment can go. Nothing here reads a message -
 * no `*:history` scope is asked for, so connecting this cannot expose a conversation.
 */
const SCOPES = [
  'chat:write', 'files:write',
  'channels:read', 'groups:read', 'im:read', 'mpim:read', 'users:read',
  'im:write', // to message someone there is no DM with yet
];

const LOGIN_TTL = 10 * 60 * 1000;
const LIST_TTL = 10 * 60 * 1000; // users.list is Tier 2; a review is many picks over a few minutes
const RECENT_MAX = 10;
const SHARE_PER_MIN = 10;

/** Not a secret - it identifies the app, and PKCE is what proves the exchange is ours. */
function clientId() {
  if (process.env.LOCAL_ARTIFACT_SLACK_CLIENT_ID) return process.env.LOCAL_ARTIFACT_SLACK_CLIENT_ID;
  try {
    return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'slack-app.json'), 'utf8')).clientId || '');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- errors

/**
 * Slack's error codes are the diagnosis; this is the prescription. They surface on the comment
 * panel, where there is room for one line and no room for a support thread.
 */
function explain(code) {
  switch (code) {
    case 'not_in_channel': return 'you are not in that channel';
    case 'channel_not_found': return 'that conversation no longer exists - pick another';
    case 'is_archived': return 'that channel is archived';
    case 'missing_scope':
    case 'not_allowed_token_type': return 'the Slack app is missing a permission - reinstall it, then run /slack login';
    case 'token_expired':
    case 'token_revoked':
    case 'invalid_auth':
    case 'account_inactive': return 'the Slack connection has expired - run /slack login';
    case 'ratelimited': return 'Slack is rate limiting - try again in a moment';
    case 'file_upload_size_error': return 'the screenshot was too large for Slack';
    default: return code || 'unknown error';
  }
}

/** True for the ones only a fresh login fixes - the connection is reported as broken, not busy. */
const isAuthError = (code) => /^(token_expired|token_revoked|invalid_auth|account_inactive|missing_scope)$/.test(code);

async function api(method, params, token) {
  let res;
  try {
    res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new Error(e?.name === 'TimeoutError' ? 'Slack did not answer in time' : 'could not reach Slack');
  }
  const j = await res.json().catch(() => ({}));
  if (!j.ok) {
    const code = j.error || `http ${res.status}`;
    throw Object.assign(new Error(explain(code)), { code, auth: isAuthError(code) });
  }
  return j;
}

// ---------------------------------------------------------------- the connection

let cached = null; // the parsed token file, or null when there is none
let cachedMtime = 0;

/**
 * Cached against the file's own modification time rather than a clock: the file is the record,
 * and it can be rewritten by a login in another session or removed by `/slack logout`. A
 * time-based cache would keep answering with a token that has just been revoked.
 */
function readToken() {
  let mtime;
  try {
    mtime = fs.statSync(TOKEN_FILE).mtimeMs;
  } catch {
    cached = null;
    return null;
  }
  if (cached && cachedMtime === mtime) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    cachedMtime = mtime;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * The two always move together: a token with no mtime to check it against is a token `readToken`
 * could hand back long after the file said otherwise, so a stat that fails drops the cache rather
 * than leaving half of it. 0 is never a real mtime, so the next read goes to the file.
 */
function cacheToken(t) {
  cached = t;
  try { cachedMtime = fs.statSync(TOKEN_FILE).mtimeMs; } catch { cached = null; cachedMtime = 0; }
}

function writeToken(t) {
  writeFileAtomic(TOKEN_FILE, `${JSON.stringify(t, null, 2)}\n`, 0o600);
  cacheToken(t);
}

function forgetToken() {
  try { fs.rmSync(TOKEN_FILE, { force: true }); } catch {}
  cached = null;
  cachedMtime = 0;
  lists = null;
}

/** What the overlay and `/comments` are told. Never the token itself. */
export function status() {
  const t = readToken();
  return {
    configured: Boolean(clientId()),
    connected: Boolean(t?.token),
    user: t?.userName || t?.userId || '',
    team: t?.teamName || '',
    last: lastShare,
  };
}

/**
 * The token to call with, refreshed if Slack issued a rotating one. Apps that opted into PKCE
 * get rotating tokens whether they asked for them or not, so both shapes have to work: with a
 * refresh token the access token is swapped before it expires, without one it simply lasts.
 */
async function ensureFresh() {
  const t = readToken();
  if (!t?.token) {
    throw Object.assign(new Error('Slack is not connected - run /slack login'), { status: 409 });
  }
  if (!t.refreshToken || !t.expiresAt || Date.now() < t.expiresAt - 60000) return t.token;
  let j;
  try {
    j = await api('oauth.v2.access', {
      client_id: clientId(), grant_type: 'refresh_token', refresh_token: t.refreshToken,
    });
  } catch (e) {
    // A refresh token of a PKCE app expires after 30 days, and revoking the app kills it sooner.
    throw Object.assign(new Error('the Slack connection has expired - run /slack login'), { status: 409, cause: e });
  }
  const a = j.authed_user || j;
  const next = {
    ...t,
    token: a.access_token || t.token,
    refreshToken: a.refresh_token || t.refreshToken,
    expiresAt: a.expires_in ? Date.now() + a.expires_in * 1000 : null,
  };
  try {
    writeToken(next);
  } catch (e) {
    /**
     * Slack has already rotated by the time this runs: the old refresh token is spent and this
     * pair is the only one that still works. Refusing the call now would lose the comment the
     * user is sharing for a token that is in hand, so the share goes ahead and the pair is kept
     * in memory - pinned to the file that could not be replaced, so a login in another session
     * still wins - and this daemon keeps working until it restarts. Stderr is the only place the
     * bad news fits: `lastShare` is about to be overwritten by the share this was for.
     */
    cacheToken(next);
    console.error(`slack: the refreshed token could not be saved (${e.message}) - it is lost when the bridge restarts`);
  }
  // From here rather than from `cached`, which a failed stat is allowed to have emptied.
  return next.token;
}

// ---------------------------------------------------------------- login

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pending = new Map(); // state -> { verifier, at }

const prunePending = () => {
  for (const [k, v] of pending) if (Date.now() - v.at > LOGIN_TTL) pending.delete(k);
};

/** The URL to send the user to. The verifier stays here; only its hash goes to Slack. */
export function startLogin() {
  const id = clientId();
  if (!id) {
    throw Object.assign(
      new Error('no Slack app is configured - put its client id in slack-app.json'),
      { status: 409 },
    );
  }
  prunePending();
  const verifier = b64url(randomBytes(48));
  const state = b64url(randomBytes(16));
  pending.set(state, { verifier, at: Date.now() });
  const u = new URL(AUTHORIZE);
  u.searchParams.set('client_id', id);
  u.searchParams.set('user_scope', SCOPES.join(','));
  u.searchParams.set('redirect_uri', REDIRECT);
  u.searchParams.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  return { url: u.toString(), redirect: REDIRECT };
}

/** Constant-time, because the state is the only thing standing between this route and a stranger. */
function takePending(state) {
  prunePending();
  const want = Buffer.from(String(state || ''));
  for (const [k, v] of pending) {
    const have = Buffer.from(k);
    if (have.length === want.length && timingSafeEqual(have, want)) {
      pending.delete(k); // single use: a code that came back twice is not a second login
      return v;
    }
  }
  return null;
}

export async function finishLogin(code, state) {
  const p = takePending(state);
  if (!p) throw new Error('this login link has expired - run /slack login again');
  if (!code) throw new Error('Slack sent no code back');
  const j = await api('oauth.v2.access', {
    client_id: clientId(), // no client_secret: PKCE apps are public clients
    code: String(code),
    code_verifier: p.verifier,
    redirect_uri: REDIRECT,
  });
  const a = j.authed_user || {};
  if (!a.access_token) throw new Error('Slack returned no user token - check the app asks for user scopes');
  const t = {
    token: a.access_token,
    refreshToken: a.refresh_token || null,
    expiresAt: a.expires_in ? Date.now() + a.expires_in * 1000 : null,
    userId: a.id || '',
    userName: '',
    teamId: j.team?.id || '',
    teamName: j.team?.name || '',
    at: new Date().toISOString(),
  };
  // A name to show, so the panel can say who it will post as. Best effort: the connection works
  // without it, and a failure here must not lose the token that has just been issued.
  try {
    const who = await api('users.info', { user: t.userId }, t.token);
    t.userName = who.user?.profile?.display_name || who.user?.real_name || who.user?.name || '';
  } catch {}
  writeToken(t);
  lists = null;
  return { user: t.userName || t.userId, team: t.teamName };
}

export async function logout() {
  const t = readToken();
  // Revoked at Slack first: deleting the file alone would leave a live token behind.
  if (t?.token) { try { await api('auth.revoke', {}, t.token); } catch {} }
  forgetToken();
}

// ---------------------------------------------------------------- destinations

let lists = null; // { at, convos, users, truncated }

/**
 * Five pages of 200 and no more: each page is one Tier 2 call, so a cold start already costs up
 * to ten of them, and no cap is large enough for the workspaces that would need one - the picker
 * shows 30 rows and is searched, not scrolled. So the cap stays and the stop is reported instead:
 * a cursor still in hand means Slack has more, and a colleague missing from the list has to be
 * something the panel can say rather than something it silently does.
 */
const PAGES = 5;

const paged = async (method, params, token, pick) => {
  const out = [];
  let cursor = '';
  for (let i = 0; i < PAGES; i++) {
    const j = await api(method, { ...params, limit: '200', ...(cursor ? { cursor } : {}) }, token);
    out.push(...pick(j));
    cursor = j.response_metadata?.next_cursor || '';
    if (!cursor) break;
  }
  return { rows: out, truncated: Boolean(cursor) };
};

/** `mpdm-ann--bob--cat-1` is how Slack names a group DM; the people in it are the useful part. */
const mpimLabel = (name) => String(name || '')
  .replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--').filter(Boolean).join(', ');

async function load(token) {
  if (lists && Date.now() - lists.at < LIST_TTL) return lists;
  /**
   * Two chains, each sequential in itself because a cursor only exists once the page before it
   * came back - but nothing in one waits on the other, and the picker says "Loading…" for as long
   * as this takes. `Promise.all` subscribes to both before either settles, so the loser of a race
   * to fail is still a handled rejection, and `lists` is assigned below only if both arrived.
   */
  const [convos, members] = await Promise.all([
    paged('users.conversations', {
      types: 'public_channel,private_channel,mpim,im', exclude_archived: 'true',
    }, token, (j) => j.channels || []),
    paged('users.list', {}, token, (j) => j.members || []),
  ]);
  const users = new Map();
  for (const u of members.rows) {
    if (u.deleted || u.is_bot || u.id === 'USLACKBOT') continue;
    users.set(u.id, u.profile?.display_name || u.real_name || u.name || u.id);
  }
  lists = {
    at: Date.now(), convos: convos.rows, users, truncated: convos.truncated || members.truncated,
  };
  return lists;
}

function readRecent() {
  try {
    const raw = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function remember(dest) {
  const kept = readRecent().filter((r) => r.id !== dest.id).slice(0, RECENT_MAX - 1);
  try {
    writeFileAtomic(RECENT_FILE, `${JSON.stringify([{ ...dest, at: Date.now() }, ...kept], null, 2)}\n`, 0o600);
  } catch {}
}

/**
 * Where a comment can go: the conversations this person is already in, plus everyone they could
 * open a DM with. Recent picks come first - a review is usually filed in the same place twice.
 */
export async function destinations(q = '') {
  const token = await ensureFresh();
  const { convos, users, truncated } = await load(token);
  const rows = [];
  const seenUser = new Set();
  for (const c of convos) {
    if (c.is_im) {
      const name = users.get(c.user);
      if (!name) continue; // a deleted account or a bot DM
      seenUser.add(c.user);
      rows.push({ id: c.id, kind: 'im', label: `@${name}` });
    } else if (c.is_mpim) {
      rows.push({ id: c.id, kind: 'mpim', label: mpimLabel(c.name) });
    } else {
      rows.push({ id: c.id, kind: c.is_private ? 'private' : 'channel', label: `#${c.name}` });
    }
  }
  // Someone there is no DM with yet is still a destination; `share` opens the conversation.
  for (const [id, name] of users) {
    if (!seenUser.has(id)) rows.push({ id, kind: 'user', label: `@${name}` });
  }

  /**
   * `#` and `@` narrow the kind, which is what the search box promises: every row is already
   * labelled with one of them, so typing the prefix reads as filtering rather than as a syntax
   * to learn. Anything else matches a name of either kind.
   */
  const typed = String(q || '').trim().toLowerCase();
  const kind = /^[#@]/.test(typed) ? typed[0] : '';
  const needle = kind ? typed.slice(1) : typed;
  const people = (r) => r.kind === 'user' || r.kind === 'im' || r.kind === 'mpim';
  const matched = rows.filter((r) => {
    if (kind === '#' && people(r)) return false;
    if (kind === '@' && !people(r)) return false;
    return !needle || r.label.toLowerCase().includes(needle);
  });
  const recent = new Map(readRecent().map((r, i) => [r.id, i]));
  matched.sort((a, b) => {
    const ra = recent.has(a.id) ? recent.get(a.id) : Infinity;
    const rb = recent.has(b.id) ? recent.get(b.id) : Infinity;
    if (ra !== rb) return ra - rb;
    // Then what the search actually starts with, so typing "des" surfaces #design before
    // #frontend-design. Channels before people, since that is where review talk lives.
    const sa = needle ? Number(!a.label.toLowerCase().replace(/^[#@]/, '').startsWith(needle)) : 0;
    const sb = needle ? Number(!b.label.toLowerCase().replace(/^[#@]/, '').startsWith(needle)) : 0;
    if (sa !== sb) return sa - sb;
    const ka = a.kind === 'user' || a.kind === 'im' ? 1 : 0;
    const kb = b.kind === 'user' || b.kind === 'im' ? 1 : 0;
    if (ka !== kb) return ka - kb;
    return a.label.localeCompare(b.label);
  });
  // `truncated` is about what Slack gave, not about the 30 shown: the rows below are a screenful
  // of a full list, but a truncated one is missing names no amount of typing will bring back.
  return { rows: matched.slice(0, 30), truncated, user: readToken()?.userName || '' };
}

// ---------------------------------------------------------------- sharing

let lastShare = null; // { ok, at, label, error } - what `/comments` reports

/**
 * A page can ask the extension to share, and a page can be hostile. The panel's own guards -
 * a closed shadow root, trusted events only - are the real defence; this is the backstop that
 * keeps a bug on the other side of them from turning into a hundred messages in a channel.
 */
export const allowShare = rateLimiter(SHARE_PER_MIN, 60000);

async function upload(token, filename, buf, title, { alt } = {}) {
  const j = await api('files.getUploadURLExternal', {
    filename,
    length: String(buf.length),
    ...(alt ? { alt_txt: alt.slice(0, 1000) } : {}),
  }, token);
  // The upload URL is pre-signed; it takes the bytes and no Authorization header.
  const res = await fetch(j.upload_url, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: buf,
    signal: AbortSignal.timeout(20000),
  }).catch(() => null);
  if (!res?.ok) throw new Error(`could not upload ${filename} to Slack`);
  return { id: j.file_id, title };
}

/**
 * One comment, one message: the quoted comment, the page, the anchor detail in a code block,
 * and the screenshot.
 *
 * With a screenshot the message is the upload's own `initial_comment` - which is also why the
 * picture always ends up below the text, since Slack puts an attachment under the message it
 * came with. Without one there is no upload to hang a message on, so it is posted directly.
 */
export async function share({ dest, payload, shot }) {
  const token = await ensureFresh();
  let channel = String(dest?.id || '');
  // A Slack id and nothing else: this goes into a request as a channel, and into a DM request
  // as a user, so it is checked before either rather than trusted from the page's side.
  if (!/^[A-Z][A-Z0-9]{1,31}$/i.test(channel)) throw new Error('pick where this should go first');
  if (dest?.kind === 'user') {
    const j = await api('conversations.open', { users: channel }, token);
    channel = j.channel?.id || '';
    if (!channel) throw new Error('could not open a DM with that person');
  }
  const text = slackMessage(payload);
  if (shot?.buf) {
    const file = await upload(token, `screenshot.${shot.ext}`, shot.buf, 'Screenshot', {
      alt: payload.comment,
    });
    await api('files.completeUploadExternal', {
      files: JSON.stringify([file]),
      channel_id: channel,
      initial_comment: text,
    }, token);
  } else {
    await api('chat.postMessage', { channel, text }, token);
  }
  const label = dest.label || channel;
  remember({ id: dest.id, kind: dest.kind, label });
  lastShare = { ok: true, at: new Date().toISOString(), label };
  return { label };
}

export function shareFailed(message) {
  lastShare = { ok: false, at: new Date().toISOString(), error: String(message || '') };
}
