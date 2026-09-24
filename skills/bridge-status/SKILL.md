---
name: bridge-status
description: Check the comment bridge. Use when a comment the user left in the browser did not arrive, when they ask where comments go or whether the bridge or the Chrome extension is working, or before troubleshooting any of it.
user-invocable: false
---

# Checking the comment bridge

There is no command for this: the user does not check the bridge, you do. Run, with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/ctl.mjs" status
```

Relay it plainly. If the bridge is not running, say that `/connect` starts it.
The `browser` line says which session every comment goes to, whatever page it was left on; if it
names another session, running `/connect` here takes it over. `not this session - disconnected`
means this session ran `/disconnect` and will not be handed the browser by anything but its own
`/connect`. `/disconnect --stop` is how the bridge itself is stopped.
The `extension` line says whether anything can put the comment button on a page at all. Relay it
whenever it is not `seen`: `NOT SEEN` means the Chrome extension has never reached the bridge, so
no page carries the button and nothing can be sent - tell the user to install it from the path the
line prints. `last seen … ago` means one reached it once: open a page in Chrome, and reload the
extension at `chrome://extensions` if no button appears.
The `origins` and `previews` lists are ids for pins and comment numbers, one per origin and one
per file Claude has opened. They belong to no session and outlive the ones that used them.
If `monitor` says NOT registered, the plugin monitor never armed — the session needs a restart,
or the `when` trigger in `monitors/monitors.json` does not match `local-artifact:connect`.
If the bridge is running but `did not accept the control token`, its token file was removed;
it restores it within 30 seconds, so try again shortly.
The `slack` line is the connection the comment panel can post through, and how the last post
went; `/slack login` connects it, and a failure there names what to fix.
