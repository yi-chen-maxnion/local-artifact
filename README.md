# Local artifact comments

Claude's cloud artifacts let you point at something on the page, leave a comment, and have it
land back in the session. This does the same thing for pages that aren't artifacts — a dev
server, a generated `report.html`, a PDF — with no per-repo integration and no assumptions about
your stack.

```
/preview                              →  this session now owns the browser
open http://localhost:5173 yourself   →  the page carries a 💬 button
click 💬, point at a button, type     →  the session wakes up with the comment,
                                          the anchor, and a screenshot
```

It is one-way by design: comments go to Claude, nothing is rendered back onto the page.

Why it behaves the way it does — and what was tried before — is in
[`docs/DESIGN.md`](docs/DESIGN.md).

## Install

```bash
claude plugin marketplace add <path-to-this-repo>
claude plugin install local-artifact@local-artifact
```

Then **restart the session** — the monitor that receives comments is armed at session start.
After updating the plugin, restart open sessions too: a monitor started from older code cannot
authenticate to the new bridge.

### The Chrome extension

This is what puts the button on a page. Without it only the bookmarklet below reaches a dev
server, and a comment carries no screenshot unless the bridge served the page itself; with it,
every page you open is bound and every comment carries a true viewport capture with no prompt.

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` directory of this repo

Chrome will say the extension can "read and change all your data on all websites". Two things
need it: `chrome.tabs.captureVisibleTab` only works with `<all_urls>` (or with `activeTab`, which
only a toolbar click grants), and the overlay is meant to reach a deployed build, not just
localhost. Nothing is injected into a page unless a Claude session has been set up and the bridge
says that page belongs to it, and the toolbar menu turns any origin off for good.

Reload it from `chrome://extensions` after editing anything in `extension/`, then refresh the
pages you had open.

**The extension talks to `127.0.0.1:4517` and nothing else.** `LOCAL_ARTIFACT_PORT` moves the
daemon — for the test suite, or to get out of the way of something already on that port — but not
the extension or the bookmarklet, both of which hold that origin as a literal. On another port the
bridge still serves its own pages and comments still work from them; what stops is everything the
extension does, silently: no page is resolved, no overlay is injected, and nothing says why. Leave
the daemon on 4517 if you use the extension.

## Use

| command | what it does |
|---|---|
| `/preview` | set this session up as the one the browser reports to; takes no argument, opens nothing, starts the bridge if needed |
| `/comments` | bridge status, which session owns the browser, bound origins, screenshot count |
| `/slack [login\|logout\|status]` | connect Slack, so a comment can be posted to a channel or a person instead |

**The session owns the browser, not a URL.** That is why `/preview` takes no target: run it once
and, with the extension installed, every page *you* open carries the comment button and reports
back to that session — a second tab, another route or port, a deployed `https://` build. With
several sessions live, a page goes to whichever ran `/preview` most recently. The button's
tooltip and the panel name the repo a comment goes to.
Clicking the extension's toolbar icon opens a menu with two switches:

- **On this site** — turns the current origin off immediately, in every open tab on it, and it
  stays off across reloads (the badge says `off`).
- **Pins outside comment mode** — whether faded pins stay on pages while the tool is not armed. Off
  by default: pins appear only in comment mode (and the one being read back). This one is for every
  site.

On the page, the button sits mostly off the right edge and slides out when you approach it. Click
it — or press `c` on `localhost` pages and the ones the bridge serves — to enter comment mode.
While it is on, the page is frozen: clicks, hovers and shortcuts do not reach it, scrolling still
works. Then:

- **click** an element to anchor it
- **drag over text** to quote it, or select text first and then activate
- **drag a box** anywhere that is not text to anchor everything inside it (hold **Alt** to box
  over text)
- `Cmd/Ctrl+Enter` sends; Send and Cancel both keep you in comment mode for the next one
- `Esc` drops the panel, and a second `Esc` leaves comment mode; right-click leaves it at once

With the extension, the screenshot is taken the moment you pick the anchor — the page is frozen
while you write, so that is the page the comment is about — and Send only closes the panel.

Each sent comment leaves a numbered pin beside its anchor. Click a pin to read the comment back,
with its anchor outlined again; the bin in the corner removes the pin from the page (the comment
itself stays in the session). The panel can be dragged by its grip and follows its anchor as the
page scrolls.

In comment mode a second button appears above the first, with a red badge counting this page's
comments. It opens a list of all of them — closed again on every page load, and closed from its `✕`
or the same button. Opening and closing the list, and reading a comment back from a pin or a row,
never switch comment mode on or off. A comment whose anchor is no longer on the page has no pin; in
the list it shows a struck-through link instead of its number and a warm tint. Click any row to
read it back, scrolled into view if it is off screen.

## Posting a comment to Slack

Not everything you notice on a page is for Claude. **Slack**, next to Send, posts the comment to a
channel, a group DM or a DM — under **your own name**, as if you had written it there yourself. It
posts **instead of** sending to the session: press Send as well if you want both.

```
Slack  →  list opens (last used first)  →  click a row, and it is posted
```

Typing `#` narrows the list to channels and `@` to people. The destination is chosen every time
rather than remembered, because posting in your own name into the wrong room is not something to
get wrong quietly. A comment is optional — a screenshot with the page and element named under it
is often the whole point.

The message is the comment as a quote, the page URL, the anchor detail in a code block — select it
and paste it into your own assistant — and the screenshot attached below.

The button appears only once Slack is connected, and only on pages the extension injects into.

### One-time setup, per workspace

Someone sets the app up once:

1. Create an app at `api.slack.com/apps` → **From an app manifest**:
   ```yaml
   display_information:
     name: UI Comments
   oauth_config:
     scopes:
       user: [chat:write, files:write, channels:read, groups:read, im:read, mpim:read,
              users:read, im:write]
   ```
   These are **user** scopes: the app posts as you, not as a bot, so there is nothing to invite
   into a channel. Nothing here can read a message — no `*:history` scope is asked for.
2. **OAuth & Permissions → enable PKCE.** This marks the app a public client, which is what lets
   it work with no client secret on anyone's laptop. It cannot be undone without asking Slack, so
   do it before step 3.
3. Add the redirect URL `http://localhost:4517/slack/callback`. Slack allows a `localhost`
   redirect for PKCE apps. (If you run the bridge on another port with `LOCAL_ARTIFACT_PORT`, add
   that one too — but note that the extension itself only ever speaks to 4517, as above.)
4. Put the app's **Client ID** in `slack-app.json` in this repo. It is not a secret, and there is
   no secret to distribute.

### Then, each person

Click the extension's toolbar icon → **Slack → Connect**, and authorise in the tab that opens.
That is the whole of it; nothing else about this lives outside the browser.

The same thing from the session, for anyone who prefers it there:

```
/slack login      authorise in the browser; the token is stored on this machine only
/slack status     who it will post as, and how the last post went
/slack logout     revoke it at Slack and delete the local copy
```

No reload needed: the panel asks whether Slack is connected each time it opens. The connection is
per machine, not per project — every session on it shares one.

## Security

The bridge binds `127.0.0.1` only, answers only to a loopback `Host` header, caps request bodies,
and requires JSON for every `POST`.

- **Control routes need a token.** Registering a session, opening a file and streaming comments
  require the token the daemon writes to `$TMPDIR/claude-ui-comments/token-<port>` (mode 0600).
  The scripts send it; a web page cannot read it. Without it, `/health` says only that the bridge
  is up.
- **Pages cannot speak for the user.** On pages the extension injects into, the overlay runs in
  the extension's isolated world with a closed shadow root, so the page's own scripts can neither
  read its binding nor drive its controls. Comments from those pages are accepted only from the
  extension. A page's own origin may post directly only if that origin was opened explicitly on
  the bridge — the bookmarklet path, which nothing in the CLI reaches today (see below).
- **Comments are untrusted input.** Comment text and anchor HTML come from a web page; the skill
  tells Claude to treat them as a description of a UI change, never as instructions, and to ask
  before acting on anything else.
- **The Slack token never enters the browser.** It is a user token — it can post wherever you can
  — so it lives in `~/.config/local-artifact/slack-token.json` (mode 0600) and is used only by the
  daemon. No route hands it out; the page is told only that a connection exists and whose name it
  posts under. Listing your conversations and posting are accepted from the extension alone, which
  is why the button is not offered on pages the bridge serves itself: there the overlay shares a
  world with the page's own scripts. Posting still takes a real click on the panel, and the daemon
  caps it at ten posts a minute.

## How it works

```
page (overlay.js)                    bridge daemon 127.0.0.1:4517           claude session
  extension-bound: isolated world ─► service worker ─► POST /comment ─► SSE /events?session=…
  bridge-served / bookmarklet ─────────────────────► POST /comment          │
  screenshot: extension captureVisibleTab, ringed by the overlay   scripts/monitor.mjs
                                                                    stdout → <task_notification>

  Slack…  ─────────────────────────► service worker ─► POST /slack/share ─► slack.com
                                                        (as you, with your own token)
```

- **`/preview` claims the browser for this session**, and each origin it then resolves gets a
  `previewId` — one per origin, one per file, reused so the pins already on a page are kept. That
  id is the routing key: comments from that page reach this session and no other. Two sessions in
  two repos never cross-talk.
- **The session key is the `claude` ancestor PID**, which the monitor and `/preview` both derive,
  so they always agree.
- **The monitor is declared, not asked for**: `monitors/monitors.json` arms it the first time
  `/preview` runs in a session, and each line it prints becomes a notification carrying the whole
  comment. Only the screenshot is a path.
- **State survives a daemon restart** — previews, comment numbers and the event sequence are saved
  to `$TMPDIR/claude-ui-comments/previews-<port>.json` — and a monitor reconnects on its own.
- **Screenshots are intermediates** in `$TMPDIR/claude-ui-comments/<sessionKey>/`, removed when the
  monitor exits. Nothing is ever written into your repo.

| target | how the overlay gets in | extension needed? |
|---|---|---|
| `report.html` | bridge injects `<script src="/overlay.js">` | no |
| `spec.pdf`, `.png`, `.md`, `.txt` | bridge serves a wrapper page holding the overlay | no |
| `http://localhost:5173/…`, a deployed build | the extension injects it | yes (or bookmarklet) |

The bridge still serves the first two rows, but since `/preview` takes no target there is no
command that hands it a file: the extension's row is the one you get.

## Bookmarklet (fallback for dev servers without the extension)

**Currently unreachable from the CLI.** Comments posted by a page itself are accepted only for an
origin that was opened explicitly on the bridge, and `/preview` no longer opens anything — so the
bookmarklet works only against an origin claimed some other way. Kept here because the bridge
side of it still exists:

```
javascript:(()=>{const o='http://127.0.0.1:4517',h=document.createElement('script');h.src=o+'/console-hook.js';document.body.appendChild(h);const s=document.createElement('script');s.src=o+'/overlay.js';s.dataset.ccPreview=(/[#&]cc=([a-f0-9]{8,})/.exec(location.hash)||[])[1]||prompt('previewId (from /preview)');s.dataset.ccOrigin=o;document.body.appendChild(s)})()
```

Click it once per page load. Screenshots then use the browser's share-tab prompt.

## When a comment does not arrive

- **The panel says the bridge is not answering.** The Claude session that owned it ended and the
  daemon idle-exited five minutes later. Run `/preview` again in a session, then Send — the comment
  is still in the box.
- **`/preview` says the monitor is NOT ATTACHED.** The monitor did not arm: restart the session,
  and check that the `when` trigger in `monitors/monitors.json` is `on-skill-invoke:local-artifact:preview`.
- **`/preview` could not find the claude process.** Comments are routed by the id of the `claude`
  process above the script; nothing can be routed without one.
- **The screenshot is missing.** The notification's `shot` line says why — no extension on the
  page, the page was not the visible tab when the shot was taken (only that tab is ever
  captured), or the capture error Chrome gave. After reloading the extension, refresh the page.
- **Can't point at part of a PDF or an iframe.** In comment mode these ignore the pointer so a
  drag over them becomes a region; leave comment mode to scroll them.
- **No button on a page.** The origin may be turned off (the toolbar badge says `off`; the toolbar menu turns it back on), or no
  session has run `/preview` yet.

`/comments` shows the bridge, the session that owns the browser, and whether this session's
monitor is connected.

## Layout

```
.claude-plugin/   plugin + marketplace manifests
monitors/         the auto-armed monitor declaration
lib/              common.mjs (session key, ports, token, bridge client), format.mjs (notification text)
bridge/           server, static serving + HTML injection, PDF/image/md/text wrapper, scratch store, slack.mjs
scripts/          monitor.mjs (session side), preview.mjs, ctl.mjs
slack-app.json    the client id of the Slack app comments are posted through (not a secret)
extension/        MV3 extension, overlay.js and console-hook.js (also served by the bridge), popup (toolbar menu)
skills/           what Claude does with a comment
commands/         /preview, /comments, /slack
fixtures/         pages for checking the overlay by hand
test/             node --test suites for the bridge and the notification format
docs/             DESIGN.md
```

## Moving it to another machine

There is no `claude plugin pack`. A plugin is distributed through a **marketplace**, and this
repo is its own single-entry marketplace (`.claude-plugin/marketplace.json`), so it is already
in a shippable shape. `claude plugin validate .` confirms it.

**Via git (recommended).** Push this repo anywhere you can clone from, then on the new machine:

```bash
claude plugin marketplace add <owner>/<repo>          # GitHub shorthand, or a full git URL
claude plugin install local-artifact@local-artifact
```

Private repos work — `marketplace add` uses your existing git/`gh` credentials.

**Via a copied directory** (no git, e.g. an AirDrop or a USB stick):

```bash
claude plugin marketplace add /path/to/local-artifact-plugin
claude plugin install local-artifact@local-artifact
```

**Via a zip** — marketplace entries also accept an `archive` source: an HTTPS URL to a zip plus
its `sha256`, verified on every download. Useful for an internal file server with no git.

Whichever route, two things do **not** travel with the plugin and are needed on the new machine:

- **Node 20+** on `PATH` — the bridge and monitor are plain Node scripts with no dependencies.
- **The Chrome extension**, loaded unpacked from the cloned repo's `extension/`. Extensions are
  per-browser-profile; installing the plugin does not install it.

Nothing else is machine-specific: the port, the scratch directory and the session key are all
derived at runtime. `/slack login` opens its browser page with macOS `open`. `claude plugin tag`
can cut a `local-artifact--v0.1.0` git tag when you want versioned releases.

## Developing this plugin

Installed from a **local directory marketplace** (the way this repo is set up), `${CLAUDE_PLUGIN_ROOT}`
resolves to the repo itself — verify with `ps` on the running monitor — so script edits under
`bridge/`, `scripts/` and `lib/` take effect with no reinstall. A cache copy exists but is not
what runs. Installed from **git, a zip or a copied directory** on another machine, the plugin does
run from `~/.claude/plugins/cache/…` and edits there need a reinstall.

What still needs a restart either way: `monitors/monitors.json`, `plugin.json`, and skill or
command frontmatter — those are read when the session starts.

```bash
npm install             # dev only — see "Dependencies" below; nothing here needs it to run
npm test                # bridge routes, security checks, notification format, overlay anchoring
npm run check           # syntax-check every .mjs / .js, and refuse raw control characters
npm run reinstall       # refresh the cache copy (keeps the two in sync)
npm run installed-path  # where the cache copy lives
```

The tests start their own daemon on a free port with a private `TMPDIR`, so they never touch a
bridge in use. A daemon left running from older code is replaced the next time `/preview` runs.

### Dependencies

**The plugin has zero runtime dependencies, and must keep it that way.** It runs from a plugin
directory where nobody runs `npm install` — the marketplace copies files, not a package — so
anything under `lib/`, `bridge/`, `scripts/`, `extension/` or `monitors/` that imported a package
would break the plugin for everyone who installed it. `package.json` has no `dependencies` field
and is not meant to grow one.

There is exactly one `devDependency`: **jsdom**, so that `test/overlay.test.mjs` can execute the
real `extension/overlay.js` inside a DOM. The overlay is one classic-script IIFE, deliberately not
split into modules (three loaders, a global a hostile page can read, load-order failure modes), so
it cannot be imported — the only honest test is to run what the browser runs. jsdom was picked over
linkedom by trying both: linkedom needed eight hand-written shims before the file would start, the
largest of them `getComputedStyle` and `CSS.escape`, which are precisely what the selector and
region code is being tested on. A shim there is a lie the test would then be built on. jsdom starts
the file with none.

`node_modules/` is git-ignored, and nothing the plugin does at runtime reads it: `codeBuild()` in
`lib/common.mjs` fingerprints only the `.mjs` files directly inside `bridge/` and `lib/`, and the
bridge only ever serves files out of `extension/`.

Without `node_modules`, `npm test` fails — only `test/overlay.test.mjs`, and with one line saying
to run `npm install`. That is on purpose rather than a skip: those tests are the only cover the
overlay's 2700 lines have, and a suite that quietly reports no failures on a checkout that ran none
of them is the worse outcome. Every other test file still passes on a bare checkout.

`extension/overlay.js` is the one canonical overlay: the extension packages it, and the bridge
serves that same file. Load the unpacked extension from **this repo's** `extension/` directory, and
after changing it reload it in `chrome://extensions`. The pages in `fixtures/` are the manual
checks: `interactive.html` (the freeze), `scrolling-pane.html` and `late-render.html` (anchors),
`hostile.html` (page scripts cannot send comments), `strict-csp.html` (injection under a strict CSP),
`comment-list.html` (the list, anchors that disappear and come back, hover while scrolling).
