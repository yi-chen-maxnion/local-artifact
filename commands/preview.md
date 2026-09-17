---
description: Open a file or local URL in the browser with a comment button bound to this session
argument-hint: <file-or-url>
---

The user wants to open a target in the browser with the comment overlay bound to this session.

Their argument was: `$ARGUMENTS`

If that is empty, ask them what to open (a path relative to the project, or a `http://localhost:…`
URL) and stop — do not guess a target.

Otherwise run, with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/preview.mjs" $ARGUMENTS
```

Then relay the result. The last line reports whether the monitor attached:

- `monitor listening` — good, comments from that tab will reach this session.
- `monitor NOT ATTACHED` — the monitor did not arm. Tell the user, and check that the `when`
  trigger in `monitors/monitors.json` is the **plugin-namespaced** skill name
  (`on-skill-invoke:local-artifact:preview`), since a bare name matches nothing silently.

If the script fails instead, relay its `preview:` line. Two failures have a known fix:

- `could not find the claude process` — comments are routed by the id of the `claude` process
  above the script, and none was found. Nothing can be routed to this session; say so.
- `did not accept the control token` — the bridge's token file was removed. It restores it
  within 30 seconds; `/preview` again after that, or stop the bridge with the command the line gives.

Tell them they can click the comment button on the right edge (it slides out on hover) to point
at something. On `localhost` pages and files opened this way, `c` toggles it too; elsewhere the
key is left to the site.

Also tell them, once, that `/preview` is **setup, not just an open**: with the Chrome extension
installed, every page they open from now on carries the comment button and reports back to this
session — another tab, another route, another port, and a deployed `https://` build too. They do
not need to run `/preview` again per URL.

Then carry on — comments arrive on their own as notifications, so do not poll or wait for them.
