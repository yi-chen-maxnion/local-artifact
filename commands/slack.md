---
description: Connect Slack, so comments can be posted to a channel or a person under your own name
argument-hint: "[login|logout|status]"
---

The user wants to manage the Slack connection the comment panel posts through.

Their argument was: `$ARGUMENTS` — treat an empty one as `login`.

Run, with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/ctl.mjs" slack $ARGUMENTS
```

Then relay the result plainly.

- `login` opens Slack in the browser and waits for the authorisation to come back. When it
  succeeds it prints the name posts will appear under. No reload is needed — the panel asks
  again every time it opens.
- The same connection can be made from the extension's toolbar menu (**Slack → Connect**), which
  is what most people will use; this command is for anyone who would rather stay in the session.
- The connection is per person, not per project: it is stored once for this machine and every
  session uses it. Each teammate connects once, themselves.
- `logout` revokes the token at Slack and deletes the local copy.

Known failures and what fixes them:

- `no Slack app is configured` — nobody has filled in `slack-app.json` yet. It needs the client
  id of a Slack app with PKCE enabled; the README section *Posting a comment to Slack* has the
  one-time setup.
- `this login link has expired` — the browser was left sitting on the Slack page for more than
  ten minutes. Run `/slack login` again.
- `bridge not running` — run `/connect` first; the Slack connection lives in the
  same daemon.

Posting itself is done by the user from the comment panel, not from here: the **Slack** button
next to Send opens a list of their channels and people (`#` and `@` narrow it), and clicking a row
posts. It goes to Slack **instead of** to this session, so a comment they also want you to act on
is sent again with Send.
