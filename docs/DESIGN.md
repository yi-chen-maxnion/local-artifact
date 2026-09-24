# Design notes

Why things are the way they are. The README says how to use the plugin; this file keeps the
reasoning behind its behaviour, including the versions that were tried and taken out, so a
change does not quietly reintroduce a problem that was already solved once.

## Which pages get the button

**Every page, and only through the extension.** There is exactly one way the overlay reaches a
page: the extension's service worker asks the bridge `GET /resolve?origin=…` on each page load
and, if a session is connected, injects `__ccConfig` and `overlay.js` into its own isolated world
(and `console-hook.js` into the page's world, which is where the page's console is). Nothing else
injects anything — not the bridge into the files it serves, not a loader the page runs itself —
so with no extension installed there is no button anywhere and no comment can be sent at all.

That is a hard requirement rather than a degraded mode, so every entry point says so instead of
doing less: `/connect` prints the one `extension` line `lib/format.mjs` builds and exits `3` when
nothing has ever been seen, `scripts/open.mjs` refuses on the same rung, `/comments` prints the
same line, and the toolbar menu names the session the browser reports to. See *No extension*
under **When a comment does not arrive**.

**The session owns the browser, not a URL.** Run `/connect` once — that is the setup gesture, and
it is why the command takes no target at all: naming one URL is not what binds anything, and a URL
the user could open themselves was an argument they had no reason to type. From then on every page
they open carries the comment button and reports back to that session:
a second tab, a link that opened one, a different route, a different port, and a deployed build
at `https://…` as much as `http://localhost:5173`. Nothing has to be in the address bar.

It used to be the other way round. `/connect` minted a token, put it in the URL's hash, and the
extension read it at `document_start` and cached it in `sessionStorage` for that tab's life. So
the binding was a *tab*: open the same app in a new tab and there was no overlay at all, and a
deployed build was out of reach entirely. The token is gone entirely — there is nothing in a URL
for the bridge to read, so every tab on an origin is bound the same way, and a URL pasted anywhere
carries no routing of ours with it.

Only the extension may ask. A request carrying a web `Origin` is refused outright and never gets
CORS headers, and so is anything a browser marks as coming from a web context through
`Sec-Fetch-Site` — an `<img>` pointed at the bridge, or a page the bridge itself serves.

### One routing rule

**Every comment from every page goes to the session that ran `/connect` most recently**, and that
is asked when the comment arrives rather than when the page was first seen. Nothing a page did
claims it for a session — not being opened by name, not being served by the bridge — because a
record here is an id for pins and comment numbers and carries no session at all. Opening a file
is not a setup gesture either: `/open` deliberately does not touch the routing, or a file opened
from one session would silently move the user's own pages to it. One rule, with no second one to
reason about: the last setup gesture is the one the user just made. When the session that owns the
browser ends, it passes to the session that registered most recently. The corner button's tooltip,
the toolbar menu and the compose panel all name the repo they are sending to, so this is visible
rather than guessed; `/comments` prints it, and `/connect` says out loud when it has just taken
the browser from another live session, since that session is never told.

**The toolbar icon opens a menu**: the session the browser reports to (or that none is connected,
which is the only place that can say so without a comment being sent), the Slack connection, and
two switches — this site on or off, and whether pins show outside comment mode. The icon used to
toggle the origin on a bare click, which gave the one setting no label and left no room for
anything beside it.

**Turning a site off is immediate, and for good.** The overlay already in every open tab on that
origin leaves comment mode, drops its panel and list, and hides. It used to take effect only on the
next load, which left a page that was frozen for commenting frozen under a badge that said `off`. A
script cannot be taken out of a page, but it can be switched off; turning the site back on shows
it, or injects one into a tab loaded while the site was off. The `off` badge is painted again on
every load, because Chrome clears a tab's badge when it navigates — it used to vanish on reload
while the origin stayed off, reading as if the click had not stuck.

**Storage is the one source of truth for both switches.** The menu only writes it. Each overlay
reads it and follows its changes, so a switch flipped in one window reaches every tab; the service
worker follows it too, to repaint badges and inject where a site came back on. Every overlay runs
in the extension's own world, the ones on bridge-served pages included, so every overlay reads
that storage for itself and no page is ever asked to pass it on.

**Pins outside comment mode are off by default**, for every site at once, and the menu turns them
on. A faded marker beside every commented element is useful while reviewing and noise while simply
using the page — and the overlay reaches every page the browser opens. Off, pins appear only in
comment mode, and the one being read back, so reading a comment still shows where it was left.

The `c` shortcut only arms the tool on `localhost`, `127.0.0.1` and `[::1]` — which includes the
pages the bridge serves. Since the overlay reaches every site the browser opens, a bare letter
anywhere else is somebody's shortcut already (Gmail's compose, a tracker's "create issue"), and
swallowing it there would break the site. The tab on the right edge works everywhere. Nor does
`c` fire while the focus is on a custom element: if its shadow root is closed, a text field inside
it cannot be seen from outside at all, and the letter was being swallowed mid-word.

## Page scripts cannot speak for the user

Once a session is set up the overlay is on every site the browser visits, and whatever it sends
lands in a model's context as something the user said. So a script on the page — the site's own,
a third-party tag, a compromised CDN — must not be able to send a comment, and must not learn
enough to try.

- **The overlay runs in the extension's isolated world.** It shares the DOM with the page but
  none of its JavaScript: the page cannot read its binding (`window.__ccConfig` does not exist in
  the page's world), and it talks to the service worker with `chrome.runtime` directly, which a
  page cannot call. It used to run in the page's own world and reach the worker through a
  `postMessage` relay, which any script on the page could use just as well.
- **The panel is a closed shadow root**, so a page cannot reach in through `host.shadowRoot`, fill
  in the textarea and click Send; and every control that sends or changes something ignores
  events that are not `isTrusted`.
- **There is no relay, and no way for a page to reach the worker.** Pages the bridge serves once
  loaded the overlay with a `<script>` tag of their own and asked the extension through a
  `postMessage` channel a content script carried; they are injected into like any other origin
  now, so the channel — and everything on the page that could have used it — is gone. With it
  went the fallbacks that channel existed for: a page-world configuration read off a script tag,
  a page posting its own comment, and a capture path that asked the user to share the tab.
- **The bridge takes a comment from the extension and from nowhere else.** A pin's storage key
  carries its preview id, and the page can read its own `localStorage` — so posting that id
  straight to the bridge from the page is refused, whatever page it is. `/comment` requires a
  `chrome-extension://` `Origin`, which the browser sets and a page cannot forge; a request with
  no `Origin` at all is refused too, since curl and every other process on this machine is not
  the extension either, and a comment arrives as something the user said. **There is no CORS
  anywhere on this server**, `/comment` included — see *When a comment does not arrive*.
- **`x-cc-ext` is a sighting, never a grant.** Every request the worker makes carries the
  extension's own id, and the daemon records that an extension exists — beside a
  `chrome-extension://` Origin and nowhere else, because a page can send any header it likes by
  accepting a preflight. No route consults it to decide whether a caller may do anything, and
  none ever may.
- **The `__ccTest` seam is safe only because there is one world.** The overlay hands its internals
  to `window.__ccTest` for `test/overlay.test.mjs`; in the isolated world the `__ccTest` a page
  defines is a different object the overlay never sees. That is what lets `askExtension` — the one
  thing there that reaches outside the page — sit on the list. **If a page-world loader is ever
  reintroduced, `askExtension` comes off the seam first**, and the comment above it in
  `extension/overlay.js` says so where it would be read.
- **The console capture is the one piece in the page world**, because that is where the page's
  console is. It hands lines to the overlay as DOM events, which a page can fake — all that
  reaches is the `console` field of a comment the user is sending. It guards every step and
  truncates arguments before stringifying them: it is wrapped around someone else's console, and
  `String(Object.create(null))` throws.

`fixtures/hostile.html` tries each of these from the page and reports whether it was blocked.

Injecting into the isolated world also keeps the page's CSP out of the way. The
`<script src="chrome-extension://…">` tag the extension originally used is subject to the page's
own CSP, so a deployed app with a strict `script-src` blocked it silently; an `executeScript`
injection is not. `fixtures/strict-csp.html` is the check.

## The bridge's control surface

A page in the browser can reach `127.0.0.1:4517`, and a `POST` with a `text/plain` body is sent
without any CORS preflight — the page cannot read the answer, but whatever the request does, it
does. So every route falls into one of three kinds:

- **Control token**, for this machine's own callers: `/register`, `/connect`, `/disconnect`,
  `/shutdown`, `/open` and `/events`. The daemon writes the token to `$TMPDIR/claude-ui-comments/token-<port>` (mode 0600)
  once the port is its own, and `connect`, `open`, `ctl` and the monitor send it. A web page
  cannot read the file.
- **The extension's alone**: `/resolve`, `/status`, `/comment` and the Slack routes. What they
  hand back is the user's — which session holds the browser, where in Slack they can post — and a
  comment is something the user is said to have written. `/comment` is the strict case and takes
  only a `chrome-extension://` Origin; the others also accept a request the browser marks as
  coming from no web context at all.
- **Public**: `/health`, which without the token says only that the bridge is up; `/p/<id>/…`,
  which is the user's own file being served to the user's own browser; and `/slack/callback`,
  which is where Slack sends the browser back and cannot carry any of the above — what guards it
  is the single-use `state` the login that owns it minted.

Every `POST` must also be `application/json`, which a cross-origin page cannot send without a
preflight this server never grants anywhere.

This was not hypothetical. Session keys become directory names, and an ended session's directory
is removed recursively — so registering a session named `../../../..` with a pid that does not
exist would, on the next prune, have deleted a directory far outside the scratch area. Keys are now
refused unless they look like `p<pid>`, and the pid has to be alive.

The daemon also answers only to `Host: 127.0.0.1:<port>` or `localhost:<port>`, which is what
stops DNS rebinding — a hostname that resolves to loopback without being loopback — from making an
attacker's page same-origin with the API. And the markdown wrapper drops any link that is not
`http(s)`, `mailto`, a fragment or a relative path: that page shares the bridge's origin, so a
`javascript:` link in a note would be script running next to the API.

## Comments leave through the extension, not the page

A page on an `https://` origin fetching `http://127.0.0.1:4517` is a **local network request**.
From Chrome 142 that is gated behind a user permission, and the old server-side opt-in header
(`Access-Control-Allow-Private-Network`) no longer applies. A deployed build could not talk to the
bridge at all — and would not fail loudly; it would look exactly like the bridge being down.

So a comment from an extension-bound page is handed to the service worker and posted from there,
where it is an ordinary extension fetch covered by host permissions. Measured on Chrome 152 with
Local Network Access fully enforced: the worker reaches `http://127.0.0.1:4517` from a page on a
public `https://` origin without a prompt. A cross-origin POST from there carries
`Origin: chrome-extension://<id>` rather than the page's, which `/comment` accepts — a web page
cannot forge that scheme.

Every comment goes that way, a bridge-served page's included. There used to be a second route —
the page posting to the bridge itself, loopback to loopback — with no falling back between them:
a worker that timed out may still have delivered, and posting again sent the comment twice. The
second route is gone, and the bridge refuses a direct post from any page at all.

## One preview id per origin, and per file

The id a page's markers are stored under (`cc-pins-<previewId>` in `localStorage`) used to be
minted fresh every time a target was opened, which meant opening the same app twice silently
orphaned every pin. Ids are now created once per origin — and once per file for the pages the
bridge serves — and reused by every session. **A record is a name, not a routing decision**: it
holds an origin or a file and nothing else, no session, no claim and no rank, so the browser
passing from one session to another leaves every pin where it was and only where the next comment
goes changes. Records therefore outlive every session that used them, and nothing drops them any
more — which makes the state file the thing that has to be bounded, so it keeps the two hundred
most recently resolved and lets the rest go. A file's record is also dropped if the file itself
has gone. The overlay keeps the last hundred pins per id, which for a dev server means a hundred
across all of that origin's routes and for a served file a hundred on that file.
Ids from the older, per-target format are given their origin
when the state is loaded, and the session fields they carried are dropped there, so nothing
already on a page is lost.

**Comments are numbered per page, not per origin.** Markers are only ever drawn on the page they
were left on, so an origin-wide counter meant walking to a second route of the same app and
finding one marker numbered `#6` with nothing before it — a number that referred to a page you
were no longer looking at. A page is its path and query, the same key the markers are filed
under; never the hash, which is a route inside one page rather than a page of its own.

The numbers also had to become durable: they live on the daemon, the markers live in the browser,
and the two drift apart whenever a scratch directory is cleared or a daemon restarts. The counters
are saved with the previews, and each comment carries the highest number *that page* still has a
marker for — the page holds the evidence, so it wins, and a second `#1` can never be issued over a
pin that already says `#1`. Screenshots are named by the daemon's own sequence rather than by the
comment number, since those restart at 1 on every page.

## The corner button

The button sits mostly off the right edge and slides out when you approach it — it stays out of
the way of whatever you are actually looking at. Once comment mode is on it stays fully out and lit
for the whole interaction, writing the comment included; sliding away mid-sentence would read as
the tool having quietly switched itself off. Reading a sent comment back **leaves the mode as it
was**: opened from a pin or the list in comment mode, the tab stays lit and closing the read-back
returns to picking; opened outside it, the tab stays dark. Clicking a pin used to drop comment mode
every time, which made looking at one comment in the middle of a review pass cost re-arming the
tool. The tab reports one thing only, whether the tool is armed — and it changes tone only when the
pointer is on the tab itself, not anywhere in the dock, so pointing at the list button above it
says nothing about it.

**Every state is a change of tone, never an added edge.** Comment mode used to draw a ring inside
the tab, which reads as a second shape appearing rather than as the same one changing — and it was
easy to miss. Now hover lifts the tab off black (`#17171b` → `#34343d`), and **comment mode is the
accent**: the whole tab turns indigo with a white marker on it. Inverting to white was tried in
between and is close to invisible on a light page — which is exactly where this has to be
unmissable. The hover and press tones are mixed from the accent with `color-mix` rather than
hand-picked, so they cannot drift away from it.

At rest the tab stays black and white, so it never competes with the page it is annotating; the
accent appears only when the tool is actually armed. Inside it is the comment marker itself, the
same teardrop a sent comment leaves on the page, as an empty ring.

**The count is on the list button, not on the tab.** Once comment mode is on, a second tab slides
out above the first; it opens the list of this page's comments (see *Pins*) and carries the count
as an unread badge — red, white figures, a white rim, the way a messaging app shows one. The badge
sits on the button's left corner, since the right one is off the edge of the screen. The button
exists only in comment mode, so at rest the page shows one tab and nothing else — and that is the
only link between the two: opening or closing the list never changes comment mode or the tab, and
the list stays open when the mode ends, closed from its own `✕`. It is positioned outside the
dock's layout, so while hidden it does not widen the dock's catch zone over the page.

## Picking

- **click** an element to anchor it
- **drag over text** to select it — hovering text switches the cursor to an I-beam and **tints
  the word under the pointer**, or the single character where the writing system does not separate
  words (Chinese, Japanese). Punctuation and spaces fall through to one character too, so the tint
  always has something to sit on. No outline is drawn: boxing text reads as the element outline it
  deliberately is not.

  A blinking caret at the insertion point was tried first and was the wrong answer — it sat
  directly beneath the mouse pointer, so the one thing meant to show you where you were was the
  one thing you could not see. A tint is offset from the cursor by its own width.

  The tint tracks the pointer on **every move rather than on the dwell**, since which word you are
  over changes with every pixel, and it is painted with the transition off: a tint that glided
  after the cursor would be reporting the word you *were* on. A caret sits *between* two
  characters, so its offset alone does not say which one the pointer is on — both candidates are
  measured and the one whose box contains the pointer wins. The drag itself *is* an ordinary
  browser text selection, so the selection highlight is the feedback from then on.

  There is deliberately no full-screen capture layer. An earlier version put one in front of the
  page and briefly dropped its `pointer-events` on every mousemove to probe the caret through it.
  With synthetic events that looked fine; with a real pointer it made the cursor flicker between
  the two layers, and mid-drag it let the browser start its own native selection alongside the
  scripted one — which is how unrelated text got dragged in. Now the listeners sit on `window`
  in the capture phase, cursors are forced by a class on `<html>`, and text selection is left
  entirely to the browser, which is exact in ways nothing scripted can match.
- **drag a box** (anywhere that is not text) to anchor *every element inside it*. The outline and
  the screenshot ring mark **the box you actually dragged**, not the bounds of the elements it
  caught — the box is what you meant, and it usually says something the elements alone do not
  (spacing, alignment, the empty area between things). The box is not the anchor — the elements
  it fully contains are, reduced to the outermost ones so a card reports as one entry rather
  than forty descendants. Over a PDF or canvas nothing qualifies, so it degrades to a plain
  rect plus the screenshot, which is what keeps that case working.

  That only works if the drag reaches the page at all. A PDF viewer — and any `iframe`, `embed`
  or `object` — is a separate frame whose mouse events never arrive in this document, so for a
  while a drag over an embedded viewer did nothing, and a click into an iframe went
  straight past the freeze. While picking, those elements are made transparent to the pointer; the
  price is that they cannot be scrolled until comment mode is left. Hit-testing then passes
  through them too, so the target lookup puts them back: a point over a frame, with nothing but
  the frame's own ancestors above it, outlines and anchors the frame itself.

  The page's elements are measured once when the drag starts and filtered on each move, rather
  than walked and measured again on every mousemove — the page is frozen while the drag runs, so
  re-walking bought nothing. A scroll during the drag measures them again.
- **select text first, then activate** — the selection is anchored immediately and sent as a
  quote, so you can point at a sentence rather than at the element holding it. Nothing appears
  while you are merely selecting text to copy: commenting stays behind the same single
  affordance as everything else.
- `Cmd/Ctrl+Enter` sends. **Both Send and Cancel keep you in comment mode** — a review pass is
  several comments in a row, and neither finishing one nor abandoning one means "I am done".
  `Esc` is two-stage: once to drop the popover and go back to picking, again to switch the tool off.
  **Right-click anywhere on the page leaves comment mode outright**, from wherever you are in it.
  Inside the popover the native menu is left alone, so copy and paste still work in the textarea.

**`<html>` and `<body>` are never an anchor, nor a step in a path.** Every element is inside
them, so naming them locates nothing: a path that began `html > body >` spent its first two steps
saying nothing, and a click on empty page produced an "anchor" that was the whole document. Empty
page is no longer a target — hovering it draws nothing, clicking it does nothing, and a box dragged
there is a plain region. A quote whose text sits directly in `<body>` is sent as the quote alone,
and found again by searching the page.

Neither hover state carries a label. An earlier version tagged the hovered element with its
`tag.class` or `[data-testid]`; the outline already answers "what is under the pointer", and a
pill riding along with it was one more thing moving on a page being looked at. The only label
left is the anchor count on a region drag, which says something the box itself does not.

The element and text hover states are mutually exclusive: only one is ever shown, since a click
and a drag from that spot do genuinely different things and showing both would promise two
outcomes at once. Hold **Alt** to force a box over text instead.

Moving onto the tool's own UI — the corner tab, a pin, the panel — **drops the hover but not
comment mode**. The outline would otherwise be left stranded on whatever the cursor last passed
over on its way there, claiming to point at something while you are reaching for a control; and
dropping out of the mode instead would mean re-arming it every time you went near the button.
Coming back onto the page re-outlines immediately, with no dwell — the wait exists to resist
sweeping *across* elements, and there is nothing to sweep across on the way back. A drag in
progress is exempt, so a box pulled out over the tab keeps tracking.

## In comment mode the page is frozen

It is a thing being looked at, not something being used, so nothing that could change it is
allowed through: clicks, menus, hover cards, drags, keyboard shortcuts. Suppressing `click` alone
was not enough — most component libraries open a menu, a select or a dialog on **`pointerdown`**,
so the page could change out from under the comment before the click that was supposed to be
swallowed ever happened.

Everything is stopped in the **capture phase on `window`**. Propagation runs window → document →
element, so that is the place ahead of the listeners the page registered on `document` and below,
including the ones libraries attach before the overlay loads.

It uses `stopPropagation`, not `preventDefault`, because the browser behaviours that do *not*
change the page are exactly the ones still wanted: native text selection is the whole mechanism
behind a quoted anchor, and scrolling, find-in-page and browser shortcuts have to keep working
while you look for what to point at. Only the few defaults that really would change the page —
following a link, a middle-click, a drag — are cancelled outright. `scroll` and `wheel` are
deliberately absent from the list: scrolling is how you reach the thing you want to comment on,
and blocking wheel propagation would freeze containers that implement their own scrolling.

The freeze lasts exactly as long as comment mode, composing included — one definition, shared
with the corner button, so what the button reports and what the page does can never disagree.
A comment read back outside comment mode leaves the page live; one read back inside it keeps the
page frozen, and pressing on the page closes the read-back and picks as usual.

**Stopping events is not enough for hover.** A magnifier, a zoom-on-hover image, a card that
slides out under the cursor — any of these can be pure CSS, and a `:hover` rule has no listener
to stop. The pointer only has to cross the page on its way to the textarea for the page to react
underneath a comment being written about it. So while a comment is being composed there is a
transparent **shield** over the viewport: the pointer lands on it, and nothing below is hovered at
all. It is up only while composing — never while picking, where hit-testing the page is the entire
job — and it is the same condition the scrim already used, so the dimming and the inertness cannot
disagree.

Two things follow from it, both accepted deliberately. Page text cannot be drag-selected while the
panel is open (a quote is captured before the panel opens, and the panel's own textarea is
unaffected). And a wheel over the page scrolls the page rather than whatever scroll container
happens to be under the cursor, since the cursor is on the shield — page scrolling, the case that
matters for seeing context while writing, still works.

A third followed, and was not accepted so much as discovered. Any full-viewport layer inside the
host inherits every "this is ours" judgement made about the host: `isOurs` is a single predicate
answering two questions that have quietly diverged — *is this the tool's own interface?* and *is
this inside our host element?* The shield is the first thing for which the answers differ. Right-
click was the first casualty: the gesture that leaves comment mode landed on the shield, was
retargeted to the host, and the page-level handler stood down, so the native menu — Reload, Back —
opened over a page that is meant to be frozen. The shield forwards that one gesture itself.
Anything added later that asks `isOurs` should be checked against the shield before it is trusted.

**Keys typed into the panel never reach the page.** A keyboard event leaves the shadow root
retargeted to its host element, which no page shortcut handler recognises as a text field — so
every letter of a comment also went to the page's shortcuts. Key events from inside the panel are
stopped at the window; the character still lands in the textarea, since that is the default
action rather than propagation.

`fixtures/interactive.html` is the regression test: counters on `click`, `pointerdown`,
`mousedown`, `mouseup`, `mouseover` and `keydown`, a listener registered on `document` in the
capture phase at load, a hover card and a link. Measured on it — before comment mode every
counter increments and the hover card opens; in comment mode every delta is **0**, typing in the
panel included, the card stays shut and the link does not navigate; after leaving, everything
works again.

## The outline

**The element ring is drawn outside the element, never on top of it** — an `outline` with an
offset rather than a `border`, which is painted inside the box and covers whatever runs to the
edge: a field's own border, an icon, text with no padding.

It is also **deliberately soft**. The first version was a 2.5px line of full-strength accent
between two hard concentric bands, white and then a dark hairline — three crisp edges, which read
as a sticker pasted over the page rather than as the page being pointed at. The line kept its
2.5px and its 3px corners — thinning or rounding the line cost presence without buying softness
— and everything around it gave way instead: 72% of the same accent (the same colour said
quietly, rather than a second colour introduced), a lighter fill, and the two hard bands replaced
by blurred glows. The white one still does its real job — separating the line from busy or dark
content — but as a halo instead of an edge of its own. The drag band was softened to match.

On the live page the tool is one colour, indigo. **Red is reserved for what has to be seen at a
glance**: the ring burned into the screenshot, which has to survive being looked at out of context,
and the count badge. That ring's stroke widths are
set in output pixels rather than source pixels, so it is equally bold no matter what resolution
the capture was downscaled from, and a white halo under the red keeps it legible on dark pages.
Like the live outline it sits **outside** the anchor, 5 output pixels clear: centred on the edge,
the halo covered the first letter of every line of a paragraph whose text runs flush to its box —
in the one picture meant to show exactly what was pointed at.
It is drawn in one place, the overlay, for both capture paths: the extension only returns the
frame.

The hover outline **glides** between elements rather than jumping. Two things make that work:

- The boxes are **reused, not rebuilt**. Recreating them on each mousemove is what made the
  outline teleport — a brand new node has nothing to transition from.
- Position is animated with `translate` (a compositor property) rather than `left`/`top`, so
  following the pointer costs the page underneath no layout.

It also **waits before following**. A new target must hold the pointer for `DWELL_MS` (35ms)
before the outline moves to it, so sweeping across a row of elements on the way somewhere does
not drag the outline along behind the cursor — easing alone cannot fix that, because the box has
to look *reluctant to let go*, not merely slow to arrive. Three exceptions keep it from feeling
laggy: the first target after arming appears at once, moving within the element already outlined
does nothing, and pressing the mouse snaps immediately to whatever is under the cursor so a click
and the outline can never disagree.

A box that has just *appeared* gets a different gesture: it **opens out from its own centre**
over 200ms on `cubic-bezier(0.22, 1, 0.36, 1)`, collapsed to nothing at the element's midpoint and
expanding on **both** axes. Appearing has nothing to let go of, so the viscous curve below would
read as plain lag there; this one leaves at once and eases in, still without overshoot. It
animates `width`, `height` and `translate` rather than `scale`, so the ring keeps its full weight
throughout — a scaled box has visibly thinner sides while it is moving.

It fades in alongside, linearly. Two earlier versions were worse in instructive ways: growing at
full height drew a tall thin sliver for the first frames, so a **line flashed up before the box
arrived**; and growing from a point at full opacity replaces that with a knot of outline doing the
same thing, because a box with no size still has a ring and a halo. The fade fixes both — linear
against the front-loaded geometry curve, so the frames where there is nothing but outline are the
frames that cannot be seen.

**Only genuinely new boxes open.** Moving from one element to the next reuses the node and glides.
Confirming an anchor — clicking the outlined element, finishing a drag, releasing a selection —
repaints instantly: the box is already on screen and already in the right place, and replaying
the entrance made a click look like a second event rather than the same one being settled.

The easing is `cubic-bezier(0.75, 0, 0.22, 1)` over 280ms: **viscous, deliberately not springy.**
A damped spring was tried first and read as a *bounce* — it overshoots and snaps back. This one
covers 0.7% of the distance in the first 28ms, so the box visibly resists leaving the element it
was on, is then pulled across, and eases in without ever passing the target. Zero overshoot is
what separates "stuck to it" from "bounced onto it". Scrolling and resizing repaint with the
animation suppressed, since the box must stay pinned to its element rather than lag behind it,
and the whole thing is disabled under `prefers-reduced-motion`.

**The hover outline is bound to its element too.** It used to be painted from the element's
coordinates and nothing else, so scrolling with the pointer held still left the box on screen where
the element had been, drifting off it with every tick. It is a locator now, like the anchor being
written about, and the scroll repaint carries it along. What is under the pointer after the scroll
is picked up on the next move, as with any hover.

Both cursors are drawn, not borrowed from the OS: a native crosshair sitting next to a native
I-beam reads as two unrelated tools. They are 26×26 SVG data URIs sharing one geometry — a white
halo under an accent stroke, same round caps, hotspot at centre — so switching between them reads
as one tool changing what it points at, and both stay legible on light and dark pages. The I-beam
is drawn taller and heavier than the crosshair on purpose: over text it is the *entire* affordance,
since nothing is outlined there, so it has to be unmistakable at a glance. The native keyword is
kept only as a fallback.

A confirmed text selection is tinted rather than boxed — a border there would read as the element
outline, which is exactly what it is not.

## Anchors are found, not remembered

**A pin is anchored to the DOM, not to the page.** Storing screen coordinates and adding the
window's scroll back on only ever works for pages that scroll as one document. Most apps scroll an
inner container instead: the window never moves, so every pin and every read-back highlight sat
still while the content slid out from under it — pointing confidently at whatever now happened to
be there.

Nothing is positioned from stored coordinates any more. When an anchor is picked the overlay builds
a **locator** — how to *find* it: a selector, and for a quote the text itself, re-found across node
boundaries — and every repaint asks the DOM where that is now. `getBoundingClientRect` is already
viewport-relative and already correct inside a scroll container, so there is no scroll arithmetic
left to get wrong. A dragged region has no node to point at, so it stores the offset from an
element it contains and comes back the exact size it was dragged; only a region over a canvas or a
PDF, where there is no DOM at all, still keeps a raw rectangle.

The outline while a comment is being written and the pin once it is sent are **the same locator**,
resolved the same way. They used to be four different sources — a live Range, a live element, a
pin, and a region rectangle frozen in window-scroll coordinates — and the last of those was the
original bug again: a region dragged inside a scrolling pane stayed put on screen while its
content scrolled away, until the comment was sent.

**Selectors are built until they are unique.** A pin finds its anchor with `querySelector`, which
returns the first match, so a selector that also matched something earlier on the page pointed
confidently at the wrong element. There is no fixed depth: steps are added upwards until the
selector names exactly one element, and an id or `data-testid` is used as a step only if it is
unique on the page by itself.

**Selectors keep only classes that narrow something down.** A class is included if at most 12
elements on the page carry it. On a utility-CSS app — Tailwind and friends — `flex`,
`items-center`, `h-16` sit on hundreds of elements and describe layout, not identity, so a
selector built from them is long, brittle and says nothing about what was pointed at. Counting
actual uses is the framework-agnostic test: it keeps a CSS-module hash, a BEM block or a
component class and drops the utilities, with no pattern list to go stale. Measured on a real
Tailwind SPA: 300 distinct classes, the commonest on 1501 elements, the median on exactly 1 —
the two populations barely overlap, so the threshold does not have to be clever. It cut two real
selectors from 189 and 192 characters to 117 and 103, both still matching exactly one element.

**And the DOM is watched, not sampled once.** Resolving pins only at startup asked the page a
question it could not yet answer: an app renders *after* the overlay loads, so a reload showed no
pins at all, and they reappeared only when something happened to scroll — which was the sole
trigger for a second look. A `MutationObserver` now coalesces each burst of DOM changes into one
repaint 150ms later (a React commit is hundreds of mutations that all mean the same thing), and it
only runs while the page actually has pins to place. Measured on `fixtures/late-render.html`,
which paints 1.2s after load: unmount the content and the pins vanish while the count holds;
remount it 60px lower and they come back **at the new position, with no scroll and no resize**.

**An anchor that cannot be found is not drawn.** The element is gone, the text has changed — the
pin disappears and the panel says so. An anchor pointing confidently at the wrong thing is worse
than one that admits it is lost. The count still includes it, and the list still shows it, marked
as lost: the comment was left here, it just cannot be pointed at right now.

**A served HTML file is the exception, and only that file.** Claude edits the file the bridge is
serving, which is exactly the text and the class the selector was built from, so on reload the
pin would stay lost on top of the element it still means. When the comment is sent the bridge
records a source anchor against the file as it is then — a slice of the source, the context
around it, and where it sat in the tree — and keeps that version of the bytes, named by its hash.
The file may already be newer than the tab the user is looking at, so the element the file has at
that spot must agree with what was pointed at, by tag and by the start of its text; if it does
not, no anchor is recorded and the pin is only its selector. The next time the overlay loads the
file it asks `/reanchor`. A unique match moves the pin: the selector is rebuilt from the node the
chain names, and only if that node is actually in the DOM on screen. The pin then carries an
anchor for the new version, and that version is kept too, so the edit after it is matched from
there; the newest eight versions of a file are kept. A tie, or a chain the current DOM does not
contain, leaves the pin where it was. The match has a clock and a size limit, because it runs on
the loop every session's comments arrive on; past either, the pin is lost for that load and asked
about again on the next. Lost still means lost. The model is not asked to update anything, and
nothing is written into the file. A dev server is not this case: there the DOM is not the file,
and a miss stays a miss.

The scroll listener is registered in the **capture phase**, which is the other half of the same
bug. Scroll events do not bubble, so the plain listener it replaced only ever heard the *window*
move — in an app that scrolls a panel rather than the document, exactly the thing that never
happens. Verified: a container's scroll event reaches a window capture listener and not a bubble
one. Scroll repaints are coalesced to one per frame. `fixtures/scrolling-pane.html` is the
regression test — a pane that scrolls while the window does not. Measured across scroll positions
0 → 180 → 420 → 0, a quote pin and an element pin both hold a constant 0–2px offset from their
anchors, including when the anchor is scrolled out of view, and a pin whose selector no longer
resolves is never drawn while still being counted.

## Pins

Sent comments leave a numbered pin — the same marker the corner button carries, in the same two
states: faded out of comment mode, lit while in it, full on hover. Each pin keeps its button for as
long as it is drawn, and a repaint only moves it; rebuilding every button on every scroll threw a
hovered pin's hover away under the pointer.

**The pin sits beside its anchor, never on it.** It used to be centred on the anchor's top-left
corner, which put a quarter of the marker inside the box — directly over the first word of the
thing being commented on, which is the one thing a reader needs to see. It is placed outside the
ring now: left of the box, else above it, else below it, and only back inside when there is
genuinely nowhere clear. The one placement deliberately *not* tried is "to the right of the box",
which for a full-width element parks the marker a screen away from what it belongs to.

**Click a pin to read the comment back** — which neither arms the tool nor disarms it. Outside
comment mode the other pins stay faded and only the one being read is at full strength. It opens in the same panel it was written in,
in the same place, and **what it was left on is drawn again in the same language as when it was
picked** — a box for an element or a dragged region, a tint for quoted text. Without that, reading
a comment back leaves "which one was this?" unanswered. Unlike confirming an anchor, that box is
not already on screen, so it gets the entrance rather than being switched on. A selection is
stored as its individual line boxes rather than one bounding rect, so the tint comes back exactly
as it was rather than as a block covering the whole paragraph. Pins are remembered per preview id
in `localStorage`. A pin clicked while a comment is half written is ignored rather than throwing the
draft away.

**The controls are icons in the corner; the content is the panel.** Close and Delete used to be
text buttons sharing the footer with Send, which gave one action, one dismissal and one
destruction the same weight — and on the read-back it produced a panel whose entire job is to
show a sentence, with a footer bigger than the sentence. Now `✕` and the bin sit small and dim at
the top right, next to the anchor label, and light up on hover. Reading has no footer at all.

The comment itself is the largest thing in the read-back panel and the only one at full contrast.
It used to sit in a bordered dark box, which read as a *disabled textarea* — the shape of
something you are not allowed to edit rather than the shape of something to read. Everything else
recedes: the anchor label is dim mono, and the time it was left sits under it as a bare
timestamp — labelling it *sent* said nothing the panel had not already established.

Delete asks once, because there is no undo: the bin turns red and the line underneath says what a
second click will do, and it disarms itself after three seconds. Keeping it an icon means the
panel never grows a confirmation dialog to remove one marker. It removes the marker from the page,
which is the only copy that lives there; the comment itself reached the session when it was sent
and is not recalled.

**Every comment on the page is also in a list** — including the ones with no pin. A comment whose
anchor is gone cannot be clicked on the page, so without the list it could not be read back or
deleted at all. A sidebar that did this was built once and taken out, because it made a second
surface permanently compete with the page. This one is closed on every load and its switch only
appears in comment mode, so the page stays the surface and the list is the way back to what the
page can no longer show.

It sits beside the dock it is switched from, in the panel's dark card, with a `✕` in its corner.
Rows are in the order the comments were left, each with its number marker, the start of the
comment, and the time it was left — nothing else: the marker already says which comment it is and
whether it is lost, and the number and anchor are in the row's tooltip. A lost comment's row has a
struck-through link where the number was and a warm tint, and the header counts how many are lost. Lost is a state a row moves in and out of — an app
re-rendering, a tab panel opening — so rows are updated with the pins rather than built once.
Clicking a row brings its anchor on screen first if it is off it (instantly, whatever the page's
`scroll-behavior`, since the panel is placed against where the anchor ends up) and then reads it
back exactly as a pin would; a lost one opens beside its row. The read-back panel treats the open
list as something to keep clear of, second only to the anchor. A half-written comment blocks a row
click the same way it blocks a pin.

## The panel

**The panel sits next to what it is about, and never on top of it** — a comment written about
something you can no longer see is written half blind. Four placements are tried in order and the
first that lands clear of the anchor wins: below, above, right, left. Order is only the tie-break.
Each candidate is clamped into the viewport *first* and scored *after*, because a placement that
fits only once it has been pushed back over the anchor has not really fitted. Sitting on the
corner button costs something too, but a quarter as much as hiding the anchor: untidy, not
blinding. When the anchor is large enough that nothing can clear it, the least-covering placement
wins and the panel still stays on screen.

**And it travels with the anchor.** The panel is fixed-position, so left to itself it holds its
place on screen while the thing it is about slides away underneath — which is how a comment ends
up parked halfway down the page from the element it belongs to, and it happens on any page that
scrolls, including one that scrolls an inner pane rather than the document. It now keeps the
offset that was chosen when it opened and is carried along by whatever the anchor does next:
scrolling, a container scrolling, a re-render that moves it. The placement itself is *not*
re-scored on the way, because a panel that flips from below the anchor to above it mid-scroll is
worse than one that is merely a little lower than it would have picked. The offset is measured
against the live outline rather than against the rect the panel was opened with, so the two agree
to the pixel and the first scroll does not jump. Measured on `fixtures/scrolling-pane.html`
through scroll positions 0 → 120 → 300 → 520 → 0 and a re-render that moves the anchor 90px: the
gap between panel and anchor holds at exactly 146px throughout.

**And it can be dragged.** The placement rules know to keep off the anchor; they do not know
that the thing you also need to see is two rows below it. A grip in the panel's top-left corner
moves it anywhere, kept apart from the two buttons that *do* something so that reaching for
"move" can never land on "delete". The drag is not recorded anywhere: it moves this panel while
it is open, and the next one is placed by the same rules as ever. What it does change is the
offset the panel travels by — from wherever it is dropped it goes on following the anchor, since
the rule is that the panel stays with what it is about and being dragged is not an exemption from
it. Measured: dragged +260/−180, the gap holds through a 300px container scroll; closed and
reopened, it is back to the computed placement.

A multi-rect anchor is measured by its **extent, not its first rect**. A quoted selection is
stored as its individual line boxes, and placing the read-back panel against `rects[0]` cleared
the first line and then dropped the panel onto the rest of the quote it was there to show.

Measured, panel 400×228 in a 1992×1267 viewport, every case covering **0 px²** of its anchor and
0 px² of the dock: a small anchor in the bottom-right corner goes *above*; a full-width band goes
*below*; a tall left-hand column goes *above*; and an anchor covering the entire viewport — where
no placement can win — lands bottom-left, fully on screen and clear of the button.

**It also stays open until the comment is actually in the session.** Send puts a spinner in the
button and keeps the anchor outlined; the panel closes on success and, on failure, stays put with
the error under it and the typed comment still in the box. Closing on click and reporting
afterwards meant a failure had nowhere to land but a toast that had already gone — along with
the comment.

## Nothing disappears between two frames

A box that is deleted out from under the pointer reads as a glitch in the page rather than as the
tool letting go, so every exit is the entrance run backwards and quicker: the outline collapses
back onto the centre of what it was pointing at, the panel drops a few pixels and fades. Exits use
their own curve — an entrance eases *in* because it is asking to be noticed, an exit accelerates
*away* because it is done being looked at. Dying boxes animate in a separate container: live ones
are reused by index, and one left in that pool would be picked up and animated back in as the next
hover.

Send used to be the worst of it. The overlay has to leave its own screenshot, so it blinked out,
blinked back, and *then* the panel vanished — a flash followed by a disappearance. The next version
faded out over 110ms, stayed hidden for the capture and the round trip, had the panel removed while
still invisible, and faded back in. That was smoother, and still read as the whole tool flashing on
every Send — worse once the scrim and the list existed, since the page brightened and a large dark
card vanished and returned along with everything else.

**So the screenshot is no longer taken at Send; it is taken when the anchor is picked.** No
screenshot API can leave an element out of the picture — a tab capture and CDP alike return the
composited tab — so the tool has to step aside for the shutter somewhere,
and feedback tools that use a native capture do it at the start of the flow, where the hide is
covered by the feedback UI arriving (Sentry's widget hides itself, captures, then reopens with the
image). DOM rasterizers such as snapDOM or html-to-image avoid the hide altogether, but they cannot
draw cross-origin iframes, unreadable cross-origin images or a PDF viewer, which are precisely the
things a comment on a dev server or a spec is about.

When an anchor is picked, the panel, scrim, pins, dock and list are hidden for the one frame the
extension grabs — a double `requestAnimationFrame` first, so the hide has actually painted — and
then the panel and scrim run their entrance where they can be seen. The **outline is not hidden**:
it is what the pointer is on, so a blink there would be the most visible blink of all, and the red
ring is drawn into the frame on top of it. Send then uses that frame: the panel closes, a pin
appears, and nothing else on the page moves. The page is frozen while a comment is written, so the
frame from the moment of pointing is the page the comment is about. A frame for a comment that is
cancelled is dropped.

Chrome refuses more than two `captureVisibleTab` calls a second. A pick inside that window does not
capture — waiting would keep the overlay hidden for the wait — and neither does a pick that fails
(the tab not showing, say); for those, Send takes the frame the previous way, fading out and back.
Captures are spaced 550ms apart so that fallback does not trip the limit itself. The fade is the
manners; the `visibility` flip after it is the guarantee, since a tab that never paints would
otherwise still be at full opacity when the shutter goes.

## Screenshots

The extension takes the frame and it does so silently, so the screenshot is simply always
attached: there is no checkbox to tick and nothing to ask for. The panel's screenshot line says
what happened rather than offering a choice.

The frame is taken when the anchor is picked, not at Send — see *Nothing disappears between two
frames*.

`chrome.tabs.captureVisibleTab` accepts only `<all_urls>` or `activeTab` as a host permission, and
a specific host permission such as `http://127.0.0.1/*` is rejected; `activeTab` is granted solely
by clicking the toolbar icon, which does not fit a button that lives in the page. That permission
was once the bug: with only specific host permissions, `captureVisibleTab` failed on every call
and the overlay fell through to a second capture path, which asked the user to share the tab —
the result looked like a working feature that merely asked permission each time. When a screenshot
is missing the payload now carries a `capture` field with the capture error in it, and the
notification prints it, so a broken capture path explains itself.

**There is no second capture path, and deliberately none to add.** The screen-sharing API was
that path, and a broken capture showed up as a share-this-tab dialog on every single comment plus
a permanent sharing banner — while looking like it was working. A failed capture now yields no
screenshot, and the panel's own screenshot line turns red with the actual Chrome error attached —
a standing fact about this page's capture path rather than a notice that flies past while you are
typing.

**Only the page that asked is ever photographed.** `captureVisibleTab` captures whichever tab is
showing in the window, not the one that sent the message. Switch tabs in the moment between a pick
and the shutter, and a comment about a button went to the session with a screenshot of some other
page — someone's inbox, say. The worker now checks that the asking tab is the active one both
before and after the capture; if not, there is no screenshot, and the notification says the page
was not the visible tab.

Reloading the extension **orphans the scripts it injected into every page already open**: they
keep running but their `chrome.runtime` link is dead. The overlay checks `chrome.runtime.id`
before every call rather than deciding once at start-up, so an orphaned page says *the extension
was reloaded — refresh this page* instead of timing out silently. **After reloading the extension,
refresh any page you had open.**

## Why targets are served through the bridge

A file Claude produced has to become a *page* before anything here can work: an origin the
extension can resolve, a URL the bridge can name in a notification, and a document the overlay can
anchor into. `file://` is none of those: the worker's `originOf` answers only for `http(s)`, and
a file URL has no origin the bridge could be asked about — quite apart from Chrome granting an
extension access to file URLs only if the user goes and ticks it. So `/open` copies nothing and
serves the file in place, under `http://127.0.0.1:4517/p/<id>/`, with its own directory as the
root for relative assets.

**HTML is served byte for byte.** The bridge used to rewrite it to add its own `<script>` tags;
now the extension injects into that origin like any other, so what the person reviews is exactly
the file they were shown. Markdown, plain text and images cannot carry an overlay or a stylesheet
of their own, so those three get a small wrapper page that renders or links the file — and
anything else is shown as plain text.

**PDF is deliberately not among the kinds**: nothing can place an anchor inside Chrome's PDF
viewer, so a comment on one is a rectangle with nothing to find again — `/open` answers `415` and
`scripts/open.mjs` refuses before it even contacts the daemon, rather than wrap it into a dead end.

Opening is Claude's gesture, not the user's: there is no command that takes a file. A web address
is refused too (`400`), since every page the user opens already carries the button and there is
nothing for the bridge to do with it.

## Delivery

- **The session key is the `claude` ancestor PID**, not `CLAUDE_CODE_SESSION_ID` — the env var
  reaches Bash tool calls but is not guaranteed to reach a plugin monitor, and both sides must
  agree or comments route nowhere. The process table is read with a single `ps`, and both the
  native `claude` binary and `node …/claude` from an npm install are recognised. When no `claude`
  process is found, `/connect` says so and stops, since nothing could be routed.
- **The monitor is declared, not asked for, and only arms when you use the plugin.**
  `monitors/monitors.json` uses `when: "on-skill-invoke:local-artifact:connect"`, so the host starts
  it the first time `/connect` runs in a session — not in every session you happen to open. Each
  stdout line becomes a `<task_notification>`. `/connect` checks that the monitor actually attached
  and says so, because a mis-matched arm trigger would otherwise fail silently.
- **The whole payload is in the notification.** Claude does not fetch anything to read a comment.
  Only the screenshot is a path, because a notification is text.
- **A restarted daemon does not silently swallow comments.** The monitor process outlives daemon
  restarts, so it cannot dedupe on the sequence number alone: a restarted daemon that hands out
  numbers the monitor has already seen would have every one of those events discarded as a
  duplicate — no error, no log, the comment simply never arrives. Each daemon therefore announces
  an `instance` id in its SSE `hello`, and the monitor resets its watermark whenever that changes.
  A reset does not leave it at nothing: the same `hello` carries the daemon's own `seq`, and the
  monitor adopts it, so it is owed everything the new daemon numbers from that moment on — see
  **When a comment does not arrive** for why a watermark of 0 had to stop meaning "send me
  nothing". This bug was real and cost a comment before it was found.
- **Links survive a daemon restart.** The records, the comment counters and the event sequence
  counter are persisted to `$TMPDIR/claude-ui-comments/previews-<port>.json` — written through a
  temp file and a rename, so a crash mid-write cannot lose it — and reloaded on start, so a tab
  left open keeps working when the daemon is restarted or idle-exits. Records are not dropped
  with the session that used them; what a reload does drop is a file that no longer exists, and
  anything past the two hundred most recently resolved. An id the daemon does not know returns a
  readable HTML page saying so, not raw JSON — someone is looking at it in a browser. The seq
  counter is persisted for a specific reason: reset it and a reconnecting monitor would treat
  replayed events as already-seen and silently drop them.
- **A daemon from older code is replaced.** It would serve its own routes and answer them its own
  way,
  and fail in ways that look like the new code being broken. `/health` reports where the daemon
  was started from and a fingerprint of its code; `/connect` compares both with its own and
  restarts the daemon when they differ.
- **More than 30 comments a minute from one session are refused**, by the daemon, with a `429` the
  panel prints under the comment — the text stays in the box and can be sent again in a moment.
  The limit used to live in the monitor, where it could only drop comments the bridge had already
  answered `200` for: the panel had closed over a numbered pin, so the user was told a comment had
  arrived that nothing would ever read. Only the daemon can answer the person who pressed Send.
  It is counted per session because what is being protected is one session's attention; a page the
  bridge takes comments from can therefore spend that budget and leave the user unable to comment
  for the rest of the minute, which is inherent to any limiter and the lesser of the two harms.
- **Screenshots are intermediates**: `$TMPDIR/claude-ui-comments/<sessionKey>/`, removed when the
  monitor exits. Nothing is ever written into your repo.

## Sharing to Slack

Some of what you notice on a page is not work for Claude — it is something a person should see.
The panel therefore has a second destination, and it is an *alternative*, not a copy: **Slack…**
posts the comment to one conversation and tells the session nothing. A comment meant for both is
sent twice, by two deliberate clicks. A single button that did both would make every aside to a
colleague into a task in someone's session, and the fan-out would have no honest failure mode:
half-sent is not a state a comment panel can report.

**As the person, not as a bot.** A bot posting "yi says: make it blue" is a worse artefact than
the message it replaces — it cannot be replied to as a conversation, and it can only reach
channels the bot was invited into. So the app asks for **user** scopes and posts with a user
token: the message carries your name and avatar, lands in any channel, group DM or DM you can
reach yourself, and needs no invitation. What that costs is that the token is as powerful as the
person, which decides everything below.

- **The token lives in the daemon, never in the browser.** `~/.config/local-artifact/slack-token.json`,
  mode 0600. No route returns it; `/resolve` tells the page only that a connection exists and
  whose name it posts under. The extension asks the bridge to post; it never holds the credential
  it would post with. It is also the one thing here kept outside `$TMPDIR` — a token cleared away
  with the scratch directory would mean logging in again every few days.
- **PKCE, so there is no secret to hand round.** The app is a public client: `/slack login` mints
  a verifier, sends only its hash to Slack, and swaps the returned code with no `client_secret`.
  A team therefore shares one client id — which is not a secret — and each person authorises
  themselves. Slack allows a `localhost` redirect for PKCE apps, so the code comes back to this
  daemon rather than to a server someone has to run; the same rule is why the app asks for no bot
  scopes, since a desktop redirect cannot request them. Refresh tokens, which PKCE apps are issued
  whether they ask or not, are swapped before expiry and expire for good after 30 days, so the
  failure mode is one `/slack login`, never a wrong-looking error at the panel.
- **Connecting is done from the browser, not only from a command.** Everything else about Slack
  happens on the page, so making the one-off connection a slash command would have been the only
  part of the setup a teammate had to learn a command for. The toolbar menu has it instead, and
  `/slack login` remains for anyone already in the session. That is why `/slack/login`,
  `/slack/logout` and `/slack/status` are **not** control-token routes: they are guarded by the
  extension-only rule. Starting a login is not an action on anyone's Slack — it opens a page the
  person has to approve, and the token it yields lands in the daemon and nowhere else — and a web
  page is refused, so it cannot learn whose account this browser holds, connect another, or
  disconnect the one there is. The panel asks for that status whenever it opens, so connecting
  mid-session does not mean reloading every tab.
- **Only the extension may ask.** `/slack/destinations` and `/slack/share` use the same rule as
  `/resolve`: a web `Origin` is refused outright. The list of destinations names your channels and
  the people you talk to, and posting is done in your name — neither is something a page may ask
  for. The panel can offer the button because it runs in the extension's own world and asks the
  worker itself — which is now true on every page, the ones the bridge serves included. It was not
  always: those pages once loaded the overlay into their own world, where every script on the page
  would have shared the line to the worker, so the button was withheld there.
- **The detail is in the message, as a code block.** The message is the comment as a quote, the
  page, that block, and the screenshot.

  Three shapes were tried. An attached `ai-context.md` is a download and an open before anyone can
  use it. A Slack snippet (`snippet_type` on the upload) sounded better and renders as a card with
  a filename on it — from the channel it is indistinguishable from any other attachment, so it
  reads as a file nobody will open. The block in the message is the one where the detail is simply
  *there*: visible, selectable, and copied by dragging. Slack has no copy button on code blocks,
  which is worth knowing before designing around one.
- **Everything is escaped, the code block included.** Slack resolves `&`, `<` and `>` inside a
  fence exactly as outside one, and this text is full of page HTML — so `<!channel>` in a comment,
  a page title or an anchor's markup is text by the time Slack sees it. The block is truncated at
  3000 characters rather than allowed to fill a channel.
- **The screenshot is an attachment, which fixes its position.** Slack puts an attachment below
  the message it came with, so the picture is always under the text. Interleaving it would mean
  uploading the file privately and referencing it from a Block Kit `image` block, which risks
  other members seeing nothing where the image should be; a predictable order is worth more.
- **Without a screenshot there is no upload to hang the message on**, so that path posts with
  `chat.postMessage` instead. Both produce the same text.
- **The destination is asked for every time.** It was remembered at first, with the button naming
  it — but a destination carried over from a comment several minutes ago is exactly the kind of
  thing that posts to the wrong room in someone's own name. Choosing from the list *is* sending,
  and the bridge orders it by what was used last, so the usual answer is the first row.
- **What is left out.** The screenshot's local path, which means nothing on anyone else's machine.
  The page URL goes in whole: there is no longer a routing token of ours in it to take off.
- **The same detail Claude gets.** The code block is `detailLines`, the very lines that go into the
  notification. Two formatters would drift, and the person who pasted the stale one into their
  assistant would be the one to find out.
- **A cap, because a page can ask.** Ten posts a minute, daemon-wide. The panel's own guards are
  the real defence; this is what keeps a bug behind them from becoming a hundred messages in a
  channel.

## A comment nobody receives is a failure

The bridge writes a comment into a replay buffer and pushes it to whatever monitors are streaming
for that session. That buffer is what makes a monitor which drops and reconnects — a daemon
restart, a laptop waking — lose nothing. It also meant that a session with **no** monitor at all
was indistinguishable from one that was merely away: the comment went into the buffer, the page
was told it had been delivered, and nothing ever read it. A session where `/connect` was never
run, or whose monitor never armed, swallowed comments while reporting success.

So `/comment` now asks whether anything is listening before it accepts. A stream open for that
session is the answer; otherwise the last time one was open has to be within a minute — long
enough to cover a reconnect, short enough that an unattended session is refused. A daemon that
has only just started counts as inside the window, since its monitors are reconnecting right then.
The page gets a 409 saying to run `/connect`, with the comment still in the panel and the Slack
button still there to send it somewhere else.

## When a comment does not arrive

Several failures look alike from where the user is standing — the Send button spins and the panel
says the bridge is not answering, or no button ever appears at all — and they have quite different
causes. Each one below is something that had to be made to say which it is.

**No CORS anywhere, including `/comment`.** `/comment` once granted a preflight, for the one
caller that ever needed one: a page on `localhost:5173` posting cross-origin to the bridge on
`127.0.0.1:4517`, which the browser will not hand a response to without an
`access-control-allow-origin` header. That caller is gone. A comment now comes from the
extension's service worker, whose fetch is covered by the manifest's `host_permissions` and is
not subject to CORS at all, and `/comment` refuses every page whatever its origin — so the grant
bought nothing and the `OPTIONS` handler went with it. That was hand-checked in Chrome before it
was taken out, not reasoned about: a comment from an extension-injected `https` page still
arrives. A page attempting the POST now stops at its own preflight, which `404`s like any other
method this server does not handle.

**No extension.** The other silent failure, and the one the daemon can see: every page carries
its button because the extension puts it there, so with no extension installed a session can
connect, open a file and receive nothing, with no sign on screen of what is missing. Every
request the worker makes carries `x-cc-ext: <chrome.runtime.id>`, and the daemon records the
sighting — but only beside a `chrome-extension://` Origin, since a page can send any header it
likes through a preflight, and only as a timestamp, since nothing is ever granted on the strength
of it. `/connect`, `/comments` and `open.mjs` print the one line `lib/format.mjs` builds from it;
`/connect` and `open.mjs` exit `3` when nothing has ever been seen.

**A stream that died without saying so.** Sleep the machine, drop the Wi-Fi or flip a VPN and the
monitor's SSE socket is left half-open: nothing errors, nothing closes, and `reader.read()` waits
for a byte that is never coming. The bridge keeps accepting comments and they are never delivered
— the worst failure mode here, because it is silent on both ends.

Two things end that wait, and both funnel into the same reconnect path that a real network error
takes, so there is only one recovery route to trust:

- **The stream is never legitimately quiet.** The server sends a ping every 25s, so nothing for
  70 seconds means the connection is gone whatever it claims. The read is aborted and reopened.
- **A tick that should take 5s taking twenty means the process was suspended** — the machine
  slept. The socket almost certainly did not survive it, so it reconnects at once rather than
  waiting out the staleness window on a stream that is already dead.

TCP keepalive is set on the server side of the same socket, which is the layer that eventually
notices a peer that went away; the client-side watchdog is what makes it quick. On reconnect the
monitor re-registers and asks for everything past its watermark, so a comment accepted while the
stream was dead is delivered once the stream is back.

**That watermark used to be a number the monitor could not honestly hold.** It was the sequence
number of the last comment the monitor had *printed*, and the only writer of it was the print
itself — so it was 0 for a monitor that had just started, 0 for one that had just met a restarted
daemon, and 0 for one that had been attached for hours and simply never had a comment to print.
The third is every session before its first comment, which made the first comment of a session the
one the reconnect could not recover: the socket died silently, `/comment` wrote into it and
answered `200`, the page drew its pin, and the replay seventy seconds later was empty. The same
zero also cost every comment accepted while a monitor *process* was being restarted — the host
stops and re-arms it within one session — since the replacement started from nothing.

So the daemon says where it has got to. Its `hello` carries the current sequence number, and a
monitor with no position of its own adopts it: everything numbered before that hello is history it
was never owed, everything after it is. From its first second the monitor has a real watermark,
even when that watermark is numerically 0. Adopting it is only sound because the daemon writes the
hello, the replay and the stream's registration in one synchronous run — a `/comment` waits on its
request body before it reaches the counter, so it cannot be numbered in between and fall through
the gap.

**"Everything after 0" then has to be expressible, and `since=0` cannot say it.** Its meaning was
not changed, because a monitor is not upgraded when the daemon is: the daemon is replaced on the
next `/connect`, while a monitor lives as long as its session — days, against a daemon that is
minutes old. An old monitor sends `since=0` on every fresh start and must keep getting nothing; if
0 had been redefined, its first reconnect after the upgrade would replay fifty comments its
predecessor had already printed into the session. `/events` therefore answers a second parameter,
`from=<seq>`, which means exactly what it says — every buffered event numbered above it, zero
included — and `since` is left as the thing old monitors already believe it to be.

**The watermark is written to disk, because the monitor process is not the durable thing here.**
It goes to `$TMPDIR/claude-ui-comments/watermark-<port>-<session>.json` on every delivered
comment — human-paced, a few hundred bytes — and deliberately *not* into the session's scratch
directory, which the monitor deletes in its own `SIGTERM` handler: a watermark kept there would be
erased by precisely the event it exists to survive. It is read back only when the daemon's
`instance` matches, since a sequence number means nothing outside the daemon that issued it, and
only when the session's process started when the file says it did. That second check is about pid
reuse: the session key *is* the `claude` pid, and a pid handed out again would otherwise inherit a
stale watermark and be read comments belonging to whoever held it before. The daemon deletes the
file when it prunes the session, so in the ordinary case it is gone before the pid can come round
again.

**What this does not fix.** A comment accepted into a dead socket now *arrives* — after the
reconnect, up to seventy seconds later. It does not make the page's "sent" true at the moment the
pin is drawn, and a monitor that never comes back still loses it: the daemon has no
acknowledgement from the far end to wait for, so it cannot tell a comment that was read from one
that was merely written into a socket. Closing that would mean the monitor acknowledging each
sequence number and `/comment` answering only once it had — a real handshake, and a separate
change.

The daemon itself survives sleep — it idle-exits only when no registered session's process is
still alive, and sleeping does not end a process. What does kill it is the Claude session ending:
five minutes later the daemon exits, and a tab left open on a served file has nothing to talk to
then. The page
says so and names the fix (`/connect` again) rather than reporting a transport error, and the
comment stays in the box to be sent once it is back. The extension's page-load lookups do not
count as activity, so browsing does not keep an unused daemon alive.

There is deliberately no retry queue. A comment held in `localStorage` and flushed later would
arrive minutes after the fact, quite possibly into a different session than the one it was
written for — worse than a comment that simply says it did not send while the text is still on
screen to send again.

## Turning it off

`/disconnect` takes this session off the browser; `/disconnect --stop` also stops the bridge.
Both were missing for a long time, and the reason neither is simply "end the monitor" is the
constraint everything below is shaped by.

**The monitor never exits.** The host starts a plugin monitor the first time `/connect` runs in a
session and documents nothing about starting it again. A monitor that left on disconnect would
leave the next `/connect` in that session registered, primary, and attached to nothing — every
comment accepted and none delivered. So it stays, streaming, through a disconnect and through a
stopped bridge alike, and a disconnected session is simply one the daemon never routes to.

**So "disconnected" is the daemon's state, and it is persisted.** `/disconnect` marks the session
`detached`; if it held the browser, the browser passes on exactly as it would had the session
ended — to the most recently registered session that is not detached, or to nobody. The trap is
`/register`. The monitor sends it on every reconnect, and it hands the browser to whoever
registers when nobody holds it, so a detached session is excluded there as well as from the
handover — or the first dropped stream would quietly undo the disconnect. Sessions themselves are
not persisted (monitors re-register after a restart), which means the mark would be lost with
them and a restarted daemon would let the first reconnecting monitor take the browser back. The
detached keys are written to the state file with their pids, and an entry goes when its pid is no
longer alive, at load and on every prune: a key is a pid, and a pid comes round again. Only
`/connect` clears the mark. `/health` reports it per session, and `/comments` prints
`not this session - disconnected; /connect to take it back` on the `browser` line.

**Stopping the bridge is one routine** for `/shutdown`, SIGTERM, SIGINT, SIGHUP and the idle exit,
in this order: refuse new requests with a `503`, so nothing lands after the state is written; save
the state; write `event: bye` with the reason to every monitor's stream and end it; close the
listener and, once those goodbyes have flushed, every connection; remove the token file only if it
is still this process's, since a daemon started the moment the port came free has written its own
there; exit 0. A hard exit after three seconds covers a socket that never finishes flushing, and
the routine runs once however many times it is asked. `/shutdown` answers before any of that — the
caller has to get its `200` — with the sessions that were registered, so the command can say which
other sessions just lost their comments; they are never told otherwise.

The `bye` is what tells a stopped bridge from a restarting one. An ended stream on its own looks
like a daemon about to come straight back, which the monitor answers with twelve quick retries; a
bridge stopped on purpose comes back only when somebody runs `/connect`, so on `bye` with reason
`shutdown` the monitor goes straight to its slow retry, silently, and a 503 from a daemon on its
way out is not reported as a refusal either. A signal says `signal` instead, because a signal is
also how `/connect` replaces a daemon running older code, and there the monitors should be back on
the new one at once.

## Slash commands

There are four, and they are all the user has to know: `/connect`, `/disconnect [--stop]`,
`/comments` and `/slack [login|logout|status]`. Nothing opens a file, because opening one is Claude's gesture —
`scripts/open.mjs`, taught by the **show-file** skill — and a command for it would be one more
thing to remember for something the agent is better placed to do at the moment it has produced
the file.

The slash commands deliberately do **not** use the `` !`…` `` auto-execution form. That runs at
command-expansion time and needs a shell permission it cannot always obtain — on some connections
it fails with `Shell command permission check failed` and the command does nothing. The commands
instead ask Claude to run the script with Bash, which goes through the normal permission flow.
Note that the monitor still arms on dispatch even when the command body fails, because arming
keys off the skill invocation, not off the command succeeding.

> **The arm trigger must use the plugin-namespaced skill name** (`local-artifact:connect`, not
> `connect`). The host compares it with exact string equality against the name it emits, which is
> `<plugin>:<skill>` for plugin skills — a bare name silently matches nothing and no monitor is
> ever started. Rename the plugin and this string has to change with it. Nothing in the running
> system can notice that, so `test/plugin.test.mjs` notices it from the files on disk: it reads
> the trigger, and demands a command and a script of exactly that name.
