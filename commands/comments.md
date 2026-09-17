---
description: Show the local comment bridge status and this session's open previews
argument-hint: "[status]"
---

Run, with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/ctl.mjs" status
```

Relay it plainly. If the bridge is not running, say that `/preview <file-or-url>` starts it.
The `browser` line says which session an otherwise unbound page goes to; if it names another
session, running `/preview` here takes it over.
If `monitor` says NOT registered, the plugin monitor never armed — the session needs a restart,
or the `when` trigger in `monitors/monitors.json` does not match `local-artifact:preview`.
If the bridge is running but `did not accept the control token`, its token file was removed;
it restores it within 30 seconds, so try again shortly.
The `slack` line is the connection the comment panel can post through, and how the last post
went; `/slack login` connects it, and a failure there names what to fix.
