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
it whenever it is not a plain `seen … ago`:

- `extension  NOT SEEN` — no extension has ever reached the bridge, so no page will carry the
  button and nothing can be sent. The command exits `3` for this even though the session is
  connected. Tell the user to install it from the folder the line names (under
  `~/.config/local-artifact/`, the one place it is loaded from for good — never the plugin's own
  `extension/`): `chrome://extensions` → Developer mode on → Load unpacked. When the next line
  says `that folder is on the clipboard`, tell them that in the file picker Cmd+Shift+G then Cmd+V
  and Return opens it, since the folder is hidden. Developer mode has to stay on: turning it off
  disables the extension.
- `extension  last seen … ago` — one reached the bridge once but not recently. Tell them to open
  a page in Chrome, and to reload the extension at `chrome://extensions` if no button appears.
- `seen … ago - extension X, plugin Y - it updates itself within a page load or two` — an update
  has reached the folder and the running extension has not reloaded into it yet. Nothing to do;
  say it is updating. If they have a comment half-written, the update waits until it is sent.
- `seen … ago - an old copy that cannot update itself` — the extension from a zip install, which
  has no update code. Tell them to remove it at `chrome://extensions` and load the folder the line
  names instead, then refresh open pages once.
- `WARNING    an older copy of the extension is also loaded` — two copies are loaded at once, and
  every page gets two overlays. Tell them to remove the other one at `chrome://extensions`,
  keeping the one loaded from the folder the line names.

A line `bridge X is running from a newer copy of the plugin - restart this session to update it`
means the plugin was updated and another session already runs the new bridge; this one kept it
rather than downgrade it. Everything still works; tell them to restart this Claude Code session
when convenient, so its scripts and monitor are the new ones too.

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
