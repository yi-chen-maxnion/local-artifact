---
name: show-file
description: Open a file you have just produced or changed in the user's browser, so they can look at it and comment on it by pointing. Use when the thing you made is meant to be SEEN - an HTML page or report, a rendered markdown document, a diagram or image - and the user would review it visually rather than read it in the terminal. Not for source code, config, logs or anything you would simply quote.
---

# Showing the user a file

You produced something whose point is to be looked at. Open it yourself - there is no command
for the user to run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/open.mjs" /absolute/path/to/report.html
```

An absolute path, one file. The bridge serves it, Chrome opens it, and the page carries the same
comment button as any other page. Relay the three lines it prints - the file, the URL, and which
session its comments reach - in a sentence; do not paste the output raw.

## When it refuses

The first line of the error says which rung failed:

- `run /connect first - this session is not connected to the browser` - tell the user to run
  `/connect`, and stop. Nothing you do here connects it.
- `the monitor is not attached` - the same: `/connect` in this session, then offer to open it again.
- `<repo> is the session connected to the browser` - another session would receive the comments.
  Ask the user which session should get them; do not take the browser from the other one.
- `the extension has never reached the bridge` - the Chrome extension is what puts the comment
  button on a page, and nothing has ever reached the bridge, so the file would open into a browser
  with no button on it. Tell the user to install it at the path the line prints
  (`chrome://extensions` -> Developer mode -> Load unpacked), then open any page in Chrome once so
  the bridge sees it, and then try again.
- `PDF is not supported` - Chrome's PDF viewer admits no anchor, so a comment on one could never
  be found again. Offer the same content as HTML or markdown instead.
- `not a file` - check the path you wrote it to.

## Afterwards

Carry on with what you were doing. Comments arrive on their own as `[ui-comment]` notifications,
handled by the **ui-comments** skill - there is nothing to poll, and nothing to wait for.
