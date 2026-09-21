import { esc } from './serve.mjs';

/**
 * A link is kept only if it goes somewhere ordinary. The page this renders into shares its
 * origin with the bridge, so a `javascript:` link in a note is script running next to its API.
 * Control characters and spaces are dropped before the check, as the browser's URL parser would.
 */
function safeHref(href) {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href.replace(/[\x00-\x20]/g, ''))?.[1]?.toLowerCase();
  return !scheme || scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}

/** Deliberately small: enough structure to read a note, not a CommonMark implementation. */
function renderMarkdown(src) {
  const lines = String(src).split(/\r?\n/);
  let out = '';
  let inCode = false;
  let list = null;
  const inline = (t) =>
    esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) =>
        (safeHref(href) ? `<a href="${href}" rel="noreferrer">${text}</a>` : text));
  const closeList = () => { if (list) { out += `</${list}>`; list = null; } };
  for (const line of lines) {
    const fence = /^```/.test(line);
    if (fence) { closeList(); inCode = !inCode; out += inCode ? '<pre><code>' : '</code></pre>'; continue; }
    if (inCode) { out += esc(line) + '\n'; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { closeList(); out += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (list !== want) { closeList(); out += `<${want}>`; list = want; }
      out += `<li>${inline((ul || ol)[1])}</li>`;
      continue;
    }
    closeList();
    if (/^\s*$/.test(line)) continue;
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { out += '<hr>'; continue; }
    out += `<p>${inline(line)}</p>`;
  }
  closeList();
  return out;
}

/**
 * A wrapper page for a target that is not itself a page: an image, a markdown note, plain text.
 * The overlay the extension injects lands in this document, so anchoring and captureVisibleTab
 * work over the thing it shows.
 */
export function wrapperPage({ kind, title, src, text }) {
  const body =
    kind === 'image' ? `<div class="cc-pad"><img src="${esc(src)}" alt="${esc(title)}"></div>`
      : kind === 'markdown' ? `<article class="cc-doc">${renderMarkdown(text || '')}</article>`
        : `<pre class="cc-text">${esc(text || '')}</pre>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  html,body { margin:0; height:100%; }
  body { background:#f6f6f7; font:14px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif; }
  .cc-pad { min-height:100vh; display:grid; place-items:center; padding:24px; }
  .cc-pad img { max-width:100%; height:auto; box-shadow:0 1px 3px #0003; }
  .cc-doc { max-width:46rem; margin:0 auto; padding:48px 24px 96px; }
  .cc-doc h1,.cc-doc h2,.cc-doc h3 { line-height:1.25; margin:1.6em 0 .5em; }
  .cc-doc pre { background:#0000000d; padding:12px 14px; border-radius:6px; overflow:auto; }
  .cc-doc code, .cc-text { font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  .cc-doc pre code { font-size:12.5px; }
  .cc-text { margin:0; padding:32px 24px 96px; white-space:pre-wrap; overflow-wrap:anywhere; }
  @media (prefers-color-scheme: dark) {
    body { background:#16171a; color:#e6e6e6; }
    .cc-doc pre { background:#ffffff12; }
  }
</style></head>
<body>${body}
</body></html>`;
}

/**
 * A single card with a sentence or two in it - the only thing this daemon has to say to a
 * person who has landed on one of its own URLs rather than on a preview. `body` is already
 * markup: these are our own strings, with anything from outside escaped by the caller.
 */
function noticePage(title, heading, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#f6f6f7;
    color:#18181b; font:14px/1.65 ui-sans-serif,system-ui,-apple-system,sans-serif; }
  .box { max-width:30rem; padding:32px 34px; background:#fff; border:1px solid #e4e4e7;
    border-radius:12px; box-shadow:0 1px 3px #0000000f; }
  h1 { margin:0 0 10px; font-size:16px; }
  p { margin:0 0 12px; color:#52525b; }
  code { font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace; background:#0000000d;
    padding:2px 6px; border-radius:4px; }
  .id { color:#a1a1aa; font-size:12px; }
  @media (prefers-color-scheme: dark) {
    body { background:#161719; color:#e8e8ea; }
    .box { background:#1d1e21; border-color:#ffffff17; }
    p { color:#a9a9b2; }
    code { background:#ffffff14; }
  }
</style></head><body>
  <div class="box">
    <h1>${esc(heading)}</h1>
    ${body}
  </div>
</body></html>`;
}

/** Shown when a preview id is not known - almost always an expired link, so say so. */
export function gonePage(previewId) {
  return noticePage('Preview not found', 'This preview is no longer available', `
    <p>Preview links live as long as the Claude Code session that opened them. That session has
       ended, or the file was moved or deleted.</p>
    <p>Ask Claude to show you the file again.</p>
    <p class="id">${esc(previewId)}</p>`);
}

/** The end of `/slack login`: the tab Slack sent back, with the answer on it. */
export function slackPage(ok, detail) {
  return noticePage(
    ok ? 'Slack connected' : 'Slack not connected',
    ok ? `Connected as ${detail.user}` : 'That did not work',
    ok
      ? `<p>Comments can now be posted to Slack from the comment panel${detail.team ? ` in ${esc(detail.team)}` : ''},
          under your own name.</p>
         <p>You can close this tab.</p>`
      : `<p>${esc(detail)}</p>
         <p>Run <code>/slack login</code> in Claude Code to try again.</p>`,
  );
}
