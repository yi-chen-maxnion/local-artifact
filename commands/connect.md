---
description: Use when the user wants the comments they leave on pages in the browser to reach this session - to start a review, or to take the browser back from another session or after /disconnect.
---

The user wants this session connected to the browser, so comments from the pages they open reach
it. There is nothing to open: the command takes no argument.

Run, with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/connect.mjs"
```

Then relay the result. The last line reports whether the monitor attached:

- `monitor listening` — good, comments from the pages they open will reach this session.
- `monitor NOT ATTACHED` — the monitor did not arm. Tell the user, and check that the `when`
  trigger in `monitors/monitors.json` is the **plugin-namespaced** skill name
  (`on-skill-invoke:local-artifact:connect`), since a bare name matches nothing silently.

The `extension` line says whether anything will actually put the comment button on a page. Relay
it whenever it is not `seen`:

- `extension  NOT SEEN` — no extension has ever reached the bridge, so no page will carry the
  button and nothing can be sent. The command exits `3` for this even though the session is
  connected. Tell the user to install it, and give them the path the line names:
  `chrome://extensions` → Developer mode → Load unpacked → the `extension/` directory it prints.
- `extension  last seen … ago` — one reached the bridge once but not recently. Tell them to open
  a page in Chrome, and to reload the extension at `chrome://extensions` if no button appears.

`browser this session (taken from <repo>)` means another live session was connected and this one
has just taken the browser: say so, since the comments that were going there now come here.

If the script fails instead, relay its `connect:` line. Two failures have a known fix:

- `could not find the claude process` — comments are routed by the id of the `claude` process
  above the script, and none was found. Nothing can be routed to this session; say so.
- `did not accept the control token` — the bridge's token file was removed. It restores it
  within 30 seconds; `/connect` again after that, or stop the bridge with the command the line gives.

Then tell them what they now have: they open whatever page they like, themselves, in Chrome —
a dev server, another tab, another route or port, a deployed `https://` build — and every one of
them carries the comment button on the right edge (it slides out on hover) and reports back to
this session. They do not run `/connect` again per URL. Clicking the button, or pressing `c` on
`localhost` pages, enters comment mode, where they point at something and type. The button comes
from the Chrome extension, so if it never appears, that is what to install (see README.md).

Local files are not their job either: when you have produced a file whose point is to be looked
at, you open it for review yourself, and it arrives in the browser carrying the same button. There
is no command for them to remember.

Then carry on — comments arrive on their own as notifications, so do not poll or wait for them.
