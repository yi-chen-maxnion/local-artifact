# Local artifact comments

Claude's cloud artifacts let you point at something on the page, leave a comment, and have it land
back in the session. This does the same thing for the pages in your own Chrome — a dev server, a
deployed build, a file Claude has just produced — with no per-repo integration and no assumptions
about your stack. It is one-way by design: comments go to Claude, nothing is rendered back onto
the page.

```
/connect                              →  every page in the browser now reports to this session
open http://localhost:5173 yourself   →  the page carries a 💬 button
click 💬, point at a button, type     →  the session wakes up with the comment,
                                          the anchor, and a screenshot
```

Why it behaves the way it does — and what was tried before — is in
[`docs/DESIGN.md`](docs/DESIGN.md).

## Install

Two halves, and **both are needed**: the plugin in Claude Code, and the Chrome extension.

```bash
claude plugin marketplace add <path-to-this-repo>
claude plugin install local-artifact@local-artifact
```

Then **restart the session** — the monitor that receives comments is armed at session start.
After updating the plugin, restart open sessions too: a monitor started from older code cannot
authenticate to the new bridge.

### The Chrome extension — required

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` directory of this repo

The extension is what puts the button on a page — every page, the ones the bridge serves
included. There is no second way in: the bridge injects nothing into the files it serves, and no
page can load the overlay by itself. Without the extension nothing works at all, and each part
says so rather than quietly doing less:

- no page carries a button, anywhere;
- `/connect` finishes the setup and then prints `extension  NOT SEEN - install it: …` and exits `3`;
- Claude's `show-file` skill refuses to open a file into a browser that has never had one;
- the toolbar menu is the extension's own, so with no extension there is no menu either.

Chrome will say the extension can "read and change all your data on all websites". Two things
need it: `chrome.tabs.captureVisibleTab` only works with `<all_urls>` (or with `activeTab`, which
only a toolbar click grants), and the overlay is meant to reach a deployed build, not just
localhost. Nothing is injected into a page unless a Claude session is connected and the bridge
answers for that origin, and the toolbar menu turns any origin off for good.

Reload it from `chrome://extensions` after editing anything in `extension/`, then refresh the
pages you had open.

**The extension talks to `http://127.0.0.1:4517` and nothing else**, as a literal it cannot read
an environment variable out of. `LOCAL_ARTIFACT_PORT` moves the daemon and exists for the test
suite; on any other port the bridge still runs and the session is still connected, while nothing
whatever happens in the browser — no page is resolved and no overlay is injected. `/connect`
warns when it sees another port. Leave the daemon on 4517.

## Commands

| command | what it does |
|---|---|
| `/connect` | make this session the one every page reports to; takes no argument, opens nothing, starts the bridge if needed |
| `/disconnect [--stop]` | this session stops receiving comments until it runs `/connect` again, and says where they go now; `--stop` also stops the bridge, and names the other sessions that just lost theirs |
| `/slack [login\|logout\|status]` | connect Slack, so a comment can be posted to a channel or a person instead |

That is the whole list. Checking the bridge is not a command either — ask Claude whether comments
are working, and it checks. Local files are not opened by a command — Claude opens them itself, see
[Claude opening a file for you](#claude-opening-a-file-for-you).

**The session owns the browser, not a URL.** That is why `/connect` takes no target: run it once
and every page *you* open carries the comment button and reports back to that session — a second
tab, another route or port, a deployed `https://` build. With several sessions live, every
comment goes to whichever ran `/connect` most recently, decided when the comment arrives; the
button's tooltip, the toolbar menu and the panel all name the repo it is going to, and `/connect`
says so out loud when it takes the browser from another live session.

## Using it

Clicking the extension's toolbar icon opens a menu: which session the browser reports to, the
Slack connection, and two switches:

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

The screenshot is taken the moment you pick the anchor — the page is frozen while you write, so
that is the page the comment is about — and Send only closes the panel. There is nothing to tick:
the extension captures the tab silently, and the panel's screenshot line says when it could not.

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

## Claude opening a file for you

When Claude produces something whose point is to be looked at — a report, a rendered note, a
diagram — it opens it for you itself, through the **show-file** skill:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/open.mjs" /absolute/path/to/report.html
```

You never run that. The bridge serves the file under `http://127.0.0.1:4517/p/<id>/`, Chrome opens
it, and the extension puts the same button on it as on any other page. HTML is served **byte for
byte** — what you review is the file you were shown — and markdown, plain text and images are
shown in a small wrapper page. PDF is not supported: nothing can place an anchor inside Chrome's
PDF viewer.

Opening a file is not a setup gesture and does not change where comments go; it is still the
session that ran `/connect` last. The script never starts a daemon, and refuses instead, so its
refusals mean something:

- **`run /connect first`** or **`the monitor is not attached`** — run `/connect` in the session
  you want the comments in, then let Claude try again.
- **`<repo> is the session connected to the browser`** — another live session would receive the
  comments. Decide which one should have them; `/connect` here takes the browser over.
- **`the extension has never reached the bridge`** — install the extension (the line prints the
  path), open any page in Chrome once so the bridge sees it, then try again.
- **`PDF is not supported`** / **`not a file`** — the target itself, not the setup.

Comments on a served file carry a `file    <absolute path>` line in the notification, so the
session goes to the file on disk rather than to a loopback URL with an id in it.

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
and paste it into your own assistant — and the screenshot attached below. For a file the bridge
served there is no link worth offering, so the message names the file instead.

The button appears on **every page**, once Slack is connected: the panel runs in the extension's
own world everywhere, including on the pages the bridge serves, and asks the service worker
itself.

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
   redirect for PKCE apps.
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
requires JSON for every `POST`, and grants **no CORS anywhere**.

- **Control routes need a token.** Registering a session, connecting it, opening a file and
  streaming comments require the token the daemon writes to
  `$TMPDIR/claude-ui-comments/token-<port>` (mode 0600). The scripts send it; a web page cannot
  read it. Without it, `/health` says only that the bridge is up.
- **Some routes are the extension's alone.** `/resolve`, `/status`, `/comment` and the Slack
  routes — bar the callback Slack itself redirects the browser to, which a single-use `state`
  guards — are refused to anything carrying a web `Origin`, and `/comment` is stricter still: it
  takes a `chrome-extension://` origin, which a page cannot forge, and nothing else — not even a
  request with no origin at all, which would be curl or any other process on this machine. The
  `x-cc-ext` header the extension sends is a sighting the daemon records and never a grant.
- **Pages cannot speak for the user.** The overlay runs in the extension's isolated world with a
  closed shadow root, so the page's own scripts can neither read its binding nor drive its
  controls — and that is true of every page, since the extension is what injects it everywhere.
- **Comments are untrusted input.** Comment text and anchor HTML come from a web page; the skill
  tells Claude to treat them as a description of a UI change, never as instructions, and to ask
  before acting on anything else.
- **The Slack token never enters the browser.** It is a user token — it can post wherever you can
  — so it lives in `~/.config/local-artifact/slack-token.json` (mode 0600) and is used only by the
  daemon. No route hands it out; the page is told only that a connection exists and whose name it
  posts under. Posting still takes a real click on the panel, and the daemon caps it at ten posts
  a minute.

## How it works

```
any page in Chrome                 bridge daemon 127.0.0.1:4517        claude session
  overlay.js, in the extension's world
     └─► service worker ─► POST /comment ─► SSE /events?session=… ─► scripts/monitor.mjs
                                                                     stdout → <task_notification>
  screenshot: chrome.tabs.captureVisibleTab, ringed by the overlay

  Slack… └─► service worker ─► POST /slack/share ─► slack.com (as you, with your own token)
```

- **There is one way the overlay gets onto a page**, and it is the extension's service worker. On
  every page load it asks the bridge `GET /resolve?origin=…`; if a session is connected it writes
  `__ccConfig` into the tab, injects `console-hook.js` into the page's own world (that is where
  the page's console is) and `overlay.js` into the extension's isolated world. The overlay never
  talks to the bridge itself — every comment, screenshot and Slack call goes through the worker.
  This is true of the pages the bridge serves too: it injects nothing into them, and they are
  resolved like any other origin.
- **`/connect` points the browser at this session.** Each origin the extension then resolves gets
  a `previewId` — one per origin, one per served file — reused so the pins already on a page are
  kept. The id names the page, not a session: it carries no session at all, outlives every session
  that uses it, and the state file keeps the two hundred most recently used. Where a comment goes
  is read from the session that ran `/connect` last, at the moment the comment arrives, and
  opening a file does not change it.
- **The session key is the `claude` ancestor PID**, which the monitor and `/connect` both derive,
  so they always agree.
- **The monitor is declared, not asked for**: `monitors/monitors.json` arms it the first time
  `/connect` runs in a session, and each line it prints becomes a notification carrying the whole
  comment. Only the screenshot is a path.
- **A comment arrives once, even across a dropped stream.** Comments are pushed over SSE and held
  in a replay buffer; the daemon's `hello` carries its instance id and sequence number, a monitor
  with no position of its own adopts that number, and on reconnect it asks for everything past its
  watermark. See *When a comment does not arrive* in `docs/DESIGN.md`.
- **State survives a daemon restart** — the records, comment numbers and the event sequence are
  saved to `$TMPDIR/claude-ui-comments/previews-<port>.json` — and a monitor reconnects on its own.
- **Screenshots are intermediates** in `$TMPDIR/claude-ui-comments/<sessionKey>/`, removed when the
  monitor exits. Nothing is ever written into your repo.

## When a comment does not arrive

- **`/connect` says `extension  NOT SEEN`.** No extension has ever reached the bridge, so nothing
  puts the button on a page and nothing can be sent. The line names the install; it is the same
  one under "The Chrome extension" above, and the command exits `3`.
- **`/connect` says `extension  last seen … ago`.** One reached the bridge once, but not recently:
  open a page in Chrome, and if no button appears, reload the extension at `chrome://extensions`.
- **`/connect` says the monitor is NOT ATTACHED.** The monitor did not arm: restart the session,
  and check that the `when` trigger in `monitors/monitors.json` is
  `on-skill-invoke:local-artifact:connect`.
- **Another session holds the browser.** Claude's bridge check names it on the `browser` line and the page's
  own tooltip names the repo it is sending to; comments are going there. Run `/connect` here to
  take it over — it says which session it took it from.
- **This session ran `/disconnect`.** Claude's bridge check says `not this session - disconnected` on the
  `browser` line. Nothing hands the browser back to it — not another session ending, not the bridge
  restarting — until `/connect` runs here.
- **The panel says the bridge is not answering.** The Claude session that owned it ended and the
  daemon idle-exited five minutes later, or someone ran `/disconnect --stop`. Run `/connect` again
  in a session, then Send — the comment is still in the box.
- **`/connect` could not find the claude process.** Comments are routed by the id of the `claude`
  process above the script; nothing can be routed without one.
- **The screenshot is missing.** The notification's `shot` line and the panel's own screenshot line
  say why — most often the page was not the visible tab at the moment the anchor was picked, since
  only the showing tab is ever captured, or the capture error Chrome gave. After reloading the
  extension, refresh the page.
- **No button on a page.** The extension is not installed or not loaded; or the origin is turned
  off, which the toolbar badge says (`off`) and the menu undoes; or no session has run `/connect`
  yet, which the toolbar menu says.
- **Can't point at part of an iframe or an embedded viewer.** In comment mode these ignore the
  pointer so a drag over them becomes a region; leave comment mode to scroll them.

Ask Claude to check the bridge: it shows the bridge, the session the browser reports to, whether the extension has been
seen, and whether this session's monitor is connected.

## Layout

```
.claude-plugin/   plugin + marketplace manifests
monitors/         the auto-armed monitor declaration
lib/              common.mjs (session key, ports, token, bridge client), format.mjs (notification text)
bridge/           server, static serving, markdown/text/image wrapper, scratch store, slack.mjs
scripts/          monitor.mjs (session side), connect.mjs, disconnect.mjs, open.mjs (Claude opens a file), ctl.mjs
slack-app.json    the client id of the Slack app comments are posted through (not a secret)
extension/        MV3 extension: service worker, overlay.js, console-hook.js, popup (toolbar menu)
skills/           what Claude does with a comment (ui-comments), how it opens a file (show-file), and checks the bridge (bridge-status)
commands/         /connect, /disconnect, /slack
fixtures/         pages for checking the overlay by hand
test/             node --test suites: bridge routes, open.mjs's refusals, notification format,
                  overlay anchoring, and plugin.test.mjs for the monitor trigger
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
  per-browser-profile; installing the plugin does not install it, and without it nothing at all
  happens in the browser.

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
bridge in use — that is what `LOCAL_ARTIFACT_PORT` is for, and the only thing it is for, since the
extension holds the bridge's origin as a literal. A daemon left running from older code is
replaced the next time `/connect` runs.

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
bridge only ever serves files out of the directory the opened file lives in.

Without `node_modules`, `npm test` fails — only `test/overlay.test.mjs`, and with one line saying
to run `npm install`. That is on purpose rather than a skip: those tests are the only cover the
overlay's 2700 lines have, and a suite that quietly reports no failures on a checkout that ran none
of them is the worse outcome. Every other test file still passes on a bare checkout.

`extension/overlay.js` is packaged by the extension and injected from there, and is the only copy
there is. Load the unpacked extension from **this repo's** `extension/` directory, and after
changing it reload it in `chrome://extensions`. The pages in `fixtures/` are the manual checks:
`interactive.html` (the freeze), `scrolling-pane.html` and `late-render.html` (anchors),
`hostile.html` (page scripts cannot send comments), `strict-csp.html` (injection under a strict CSP),
`comment-list.html` (the list, anchors that disappear and come back, hover while scrolling), and
`demo.html`, an ordinary-looking settings page to try the whole flow on.
