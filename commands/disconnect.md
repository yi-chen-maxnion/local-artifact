---
description: Stop this session receiving comments from the browser; --stop also stops the bridge
argument-hint: "[--stop]"
---

The user wants this session to stop receiving comments from the pages they open. With `--stop`
they want the bridge itself off as well, for every session.

Their argument was: `$ARGUMENTS`

Run, with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/disconnect.mjs" $ARGUMENTS
```

Then relay the result plainly. The first line says what happened to this session:

- `receives no comments from now on` — done. It stays that way until `/connect` runs here again;
  nothing else hands the browser back to it, not another session ending and not the bridge
  restarting.
- `already disconnected; nothing changed` — it was already off.
- `was not connected` — there was nothing to turn off, and it will not be handed the browser later.
- `nothing to do - the bridge is not running` — no session receives comments at all.

The `browser` line says where the user's next comment goes, which matters because it goes there
whether or not they know it: say it. `comments now go to <repo>` means another live session has
just been handed the browser — tell them their comments reach that session from now on.
`no session receives comments` means nothing will take a comment until `/connect` runs somewhere.

With `--stop`, the `stop` line replaces it: the bridge is stopped, and it names any other session
that just lost its comments without being told. Say so plainly if there are any. The next
`/connect`, in any session, starts the bridge again.

The session's monitor keeps running either way, and that is deliberate: the host starts it the first time
`/connect` runs and does not promise to start one that exited, so it has to still be there for the next `/connect`. It is silent
while nothing is routed to it. Do not stop it, and do not call `Monitor` or `TaskStop` about it.

If the script fails instead, relay its `disconnect:` line. `did not accept the control token`
means the bridge's token file was removed; it restores it within 30 seconds, so try again then.
