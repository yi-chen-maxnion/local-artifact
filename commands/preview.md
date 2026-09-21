---
description: Set this session up as the one the browser sends comments to
---

The user wants this session set up to receive comments from the browser. There is nothing to
open: the command takes no argument.

Run, with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/preview.mjs"
```

Then relay the result. The last line reports whether the monitor attached:

- `monitor listening` — good, comments from the pages they open will reach this session.
- `monitor NOT ATTACHED` — the monitor did not arm. Tell the user, and check that the `when`
  trigger in `monitors/monitors.json` is the **plugin-namespaced** skill name
  (`on-skill-invoke:local-artifact:preview`), since a bare name matches nothing silently.

If the script fails instead, relay its `preview:` line. Two failures have a known fix:

- `could not find the claude process` — comments are routed by the id of the `claude` process
  above the script, and none was found. Nothing can be routed to this session; say so.
- `did not accept the control token` — the bridge's token file was removed. It restores it
  within 30 seconds; `/preview` again after that, or stop the bridge with the command the line gives.

Then tell them what they now have: they open whatever page they like, themselves, in Chrome —
a dev server, another tab, another route or port, a deployed `https://` build — and every one of
them carries the comment button on the right edge (it slides out on hover) and reports back to
this session. They do not run `/preview` again per URL. Clicking the button, or pressing `c` on
`localhost` pages, enters comment mode, where they point at something and type. The button comes
from the Chrome extension, so if it never appears, that is what to install (see README.md).

Then carry on — comments arrive on their own as notifications, so do not poll or wait for them.
