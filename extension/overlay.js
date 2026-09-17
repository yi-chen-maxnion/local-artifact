/**
 * Local artifact comments - in-page toolbar.
 *
 * One file, two worlds. Injected by the extension it runs in the extension's isolated world:
 * it shares the DOM with the page but none of its JavaScript, so a script on the page can
 * neither read which session it is bound to nor send a comment through it. Served by the
 * bridge (or loaded by the bookmarklet) it runs in the page world, and reaches the extension -
 * when present - through the content-script relay.
 */
(() => {
  // The global guards against a second injection into the same world; the host element against
  // an overlay already running in the other one.
  if (window.__ccOverlay || document.getElementById('cc-overlay-host')) return;
  window.__ccOverlay = true;

  const cfg = (() => {
    const ds = document.currentScript?.dataset || {};
    const w = window.__ccConfig || {};
    return {
      previewId: ds.ccPreview || w.previewId || null,
      origin: ds.ccOrigin || w.origin || null,
      // Which session this page is talking to. It used to be implicit - you had just run
      // /preview on this exact URL - but the overlay now appears on any page the set-up session
      // owns, including a deployed build, so where a comment is going has to be legible.
      repo: ds.ccRepo || w.repo || '',
      /**
       * Whether this browser has a Slack connection to post through, and whose name it posts
       * under. Only ever set by the extension: the panel's Slack side asks the worker for
       * everything, and in the page world - a bridge-served page, the bookmarklet - the page's
       * own scripts share this world, so there is no telling them apart from the panel.
       */
      slack: (w.slack?.connected && !ds.ccPreview) ? w.slack : null,
    };
  })();
  // Every loader - the extension, the bridge, the bookmarklet - sets both of these. Without
  // either one there is no session to speak for and no bridge to reach, so draw nothing.
  if (!cfg.previewId || !cfg.origin) return;

  const MAX_HTML = 600;
  const DRAG_THRESHOLD = 6;
  const REGION_MAX_ELEMENTS = 12;
  const PIN_KEY = `cc-pins-${cfg.previewId}`;

  // ---------------------------------------------------------------- extension bridge
  const connected = () => { try { return Boolean(globalThis.chrome?.runtime?.id); } catch { return false; } };
  /** In the extension's isolated world - decided once, since an orphaned script loses the id. */
  const isolated = connected();
  let extReady = null;
  const pending = new Map();
  let msgId = 0;

  if (!isolated) {
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.data?.__cc !== 'res') return;
      pending.get(e.data.id)?.(e.data.payload);
    });
  }

  /**
   * Always resolves to an object carrying either the worker's answer or an `{ error, code }`:
   * a timeout is a transport failure like a reloaded extension, so the transport names it once
   * here rather than leaving three callers to write the same sentence about a null.
   */
  function askExtension(type, payload, timeout = 4000) {
    return new Promise((resolve) => {
      const id = ++msgId;
      /**
       * Every exit is this one, and it is where the promise above is kept. What arrives is not
       * always the worker's: `respond()` with no argument and a port that closes both yield
       * undefined, and in the page world the payload is whatever was posted at the window -
       * including by the page itself, which shares that world. Anything that is not an object
       * is not an answer, and callers read `.error` off whatever this resolves.
       */
      const finish = (v) => {
        if (!pending.delete(id)) return;
        resolve(v && typeof v === 'object' ? v : {
          error: 'the extension sent an empty answer - refresh this page', code: 'extension_empty',
        });
      };
      setTimeout(() => finish({
        error: 'the extension did not answer - refresh this page', code: 'extension_timeout',
      }), timeout);
      if (!isolated) {
        window.postMessage({ __cc: 'req', id, type, payload }, '*');
        return;
      }
      // Reloading the extension orphans this script: it keeps running, its line to the worker gone.
      if (!connected()) return finish({ error: 'the extension was reloaded - refresh this page' });
      try {
        chrome.runtime.sendMessage({ type, payload }, (res) => {
          const err = chrome.runtime.lastError;
          // A message-less `lastError` would otherwise be an answer with an empty `error`, which
          // reads as success: a failure here always says something.
          finish(err ? { error: err.message || 'the extension could not be reached - refresh this page' } : res);
        });
      } catch (err) {
        finish({ error: String(err?.message || err) });
      }
    });
  }

  /**
   * In the isolated world the extension is there by definition, as long as it has not been
   * reloaded. In the page world it is asked, with room for a service worker that has to wake up.
   */
  const hasExtension = async () => {
    if (isolated) return connected();
    if (extReady === null) extReady = Boolean((await askExtension('ping', {}, 2000))?.ok);
    return extReady;
  };

  // ---------------------------------------------------------------- screenshots
  let displayStream = null;

  async function captureViaDisplayMedia(rect) {
    try {
      if (!displayStream || !displayStream.active) {
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true,
        });
      }
      const track = displayStream.getVideoTracks()[0];
      const out = await drawAndEncode(await new ImageCapture(track).grabFrame(), rect);
      // Stop immediately: a retained stream leaves Chrome's "sharing this tab" banner up for
      // the rest of the session, which is more alarming than re-asking on the next comment.
      for (const t of displayStream.getTracks()) t.stop();
      displayStream = null;
      return out;
    } catch {
      for (const t of displayStream?.getTracks?.() || []) t.stop();
      displayStream = null;
      return null;
    }
  }

  /**
   * Widths are in OUTPUT pixels, not source pixels, so the ring is equally bold whatever the
   * capture was downscaled from. The white halo is what makes it read on a dark page; on a
   * light one it just holds the red line clear of the content.
   */
  function drawRing(g, x, y, w, h) {
    g.lineWidth = 7;
    g.strokeStyle = 'rgba(255,255,255,.9)';
    g.strokeRect(x, y, w, h);
    g.lineWidth = 3.5;
    g.strokeStyle = RING;
    g.strokeRect(x, y, w, h);
  }

  /**
   * Ring the anchor, cap the long edge at 1568px (what the vision encoder resizes to anyway).
   * Both capture paths end here. Either frame is the viewport in device pixels, so its width
   * over the viewport's is the scale from the anchor's CSS pixels.
   */
  async function drawAndEncode(bitmap, rect) {
    const long = Math.max(bitmap.width, bitmap.height);
    const k = Math.min(1, 1568 / long);
    const c = new OffscreenCanvas(Math.round(bitmap.width * k), Math.round(bitmap.height * k));
    const g = c.getContext('2d');
    g.drawImage(bitmap, 0, 0, c.width, c.height);
    if (rect?.w > 0 && rect?.h > 0) {
      const s = (bitmap.width / innerWidth) * k;
      // Outside the anchor, like the outline on the page: centred on its edge, the halo covered the
      // first letters of every line in a paragraph whose text runs flush to its box.
      const out = 5;
      drawRing(g, rect.x * s - out, rect.y * s - out, rect.w * s + out * 2, rect.h * s + out * 2);
    }
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    return await new Promise((r) => {
      const fr = new FileReader();
      fr.onload = () => r(fr.result);
      fr.readAsDataURL(blob);
    });
  }

  /**
   * Wait for the hide above to actually paint. rAF is the accurate signal but it does not
   * fire at all in a background or occluded tab, so it is raced against a timer - otherwise
   * a comment sent from an unfocused window hangs here forever and is silently lost.
   */
  const settlePaint = () =>
    new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      requestAnimationFrame(() => requestAnimationFrame(fin));
      setTimeout(fin, 150);
    });

  /** Decoded by hand rather than fetched: a fetch of a data: URL is subject to the page's CSP. */
  function dataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(',');
    const mime = /:(.*?);/.exec(dataUrl.slice(0, comma))?.[1] || 'image/jpeg';
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  let captureError = null;
  let lastGrabAt = 0;

  /**
   * One frame of the tab from the extension, raw. Chrome allows two captures a second and refuses
   * the third, and a capture taken as an anchor is picked can be followed by another at Send, so
   * they are spaced out here rather than left to fail.
   */
  async function grabFrame() {
    const wait = lastGrabAt + 550 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGrabAt = Date.now();
    return askExtension('capture', {}, 8000);
  }

  /** A grabbed frame, ringed and encoded - or null, with the reason on the panel's screenshot line. */
  async function encodeFrame(frame, rect) {
    let error = frame?.error;
    if (frame?.dataUrl) {
      try {
        const out = await drawAndEncode(await createImageBitmap(dataUrlToBlob(frame.dataUrl)), rect);
        captureError = null;
        markShot(null);
        return out;
      } catch (err) {
        error = `could not read the capture: ${err?.message || err}`;
      }
    }
    captureError = error || 'no response from the extension';
    // Re-probe next time: the usual cause is the extension having been reloaded, and the
    // cached "yes it is there" is exactly what would keep reporting a healthy extension.
    extReady = null;
    // Said on the panel's own screenshot line rather than in a toast: it is a standing fact
    // about this page's capture path, not a one-off event to be caught as it flies past.
    markShot(captureError);
    return null;
  }

  async function screenshot(rect) {
    // With the extension installed this is the only capture path. Falling through to
    // getDisplayMedia here would ambush the user with a share-this-tab dialog and leave a
    // persistent "sharing" banner - a far worse outcome than simply having no screenshot.
    if (await hasExtension()) return encodeFrame(await grabFrame(), rect);
    if (state.wantShot) return await captureViaDisplayMedia(rect);
    return null;
  }

  // ---------------------------------------------------------------- anchor description
  const isOurs = (el) => el === host || (el && host.contains(el));
  /**
   * The page itself. Every element is inside <html> and <body>, so naming them locates nothing -
   * they are never an anchor, and never a step in a path.
   */
  const isPage = (el) => el === document.body || el === document.documentElement;
  const clean = (s, n = 200) => (s || '').trim().replace(/\s+/g, ' ').slice(0, n);
  const ownClasses = (el) => [...el.classList].filter((c) => !/^cc-/.test(c));

  /**
   * A class earns a place in the selector only if it narrows anything down. On a utility-CSS
   * app - Tailwind and friends - `flex`, `items-center`, `h-16` sit on hundreds of elements
   * and describe layout, not identity: a selector built from them is long, brittle, and says
   * nothing about what was pointed at. Counting actual uses is the framework-agnostic test.
   * It keeps a CSS-module hash, a BEM block or a component class and drops the utilities,
   * with no pattern list to go stale. Measured on a real Tailwind app: 300 distinct classes,
   * the commonest on 1501 elements, the median on exactly 1 - the two populations barely
   * overlap, so the threshold does not have to be clever.
   */
  const CLASS_USE_LIMIT = 12;
  const distinctClass = (c) => {
    if (c.length >= 30) return false;
    try { return document.getElementsByClassName(c).length <= CLASS_USE_LIMIT; } catch { return false; }
  };

  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };

  /** One step of a selector: an id or test id that is unique on its own, else tag, classes, position. */
  function selectorStep(node) {
    if (node.id && unique(`#${CSS.escape(node.id)}`)) return `#${CSS.escape(node.id)}`;
    const testid = node.getAttribute('data-testid');
    if (testid && unique(`[data-testid="${CSS.escape(testid)}"]`)) return `[data-testid="${CSS.escape(testid)}"]`;
    // `localName`, not a lowercased `tagName`: a type selector is case-insensitive only for HTML
    // elements, so `foreignobject` matches no SVG element at all - and everything nested inside
    // one, an HTML label in a chart's `<foreignObject>` included, is then unanchorable too.
    let s = node.localName;
    const cls = ownClasses(node).filter(distinctClass).slice(0, 2);
    if (cls.length) s += '.' + cls.map((c) => CSS.escape(c)).join('.');
    const sibs = node.parentElement ? [...node.parentElement.children].filter((n) => n.tagName === node.tagName) : [];
    if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(node) + 1})`;
    return s;
  }

  /**
   * Built upwards until it names exactly one element. A pin finds its anchor again with
   * querySelector, and a selector that also matches something earlier on the page points
   * confidently at the wrong thing - so there is no fixed depth, only "unique yet?".
   */
  function cssSelector(target) {
    if (!target || target.nodeType !== 1 || isPage(target)) return '';
    const parts = [];
    for (let node = target; node?.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      if (node === document.body) { parts.unshift('body'); break; }
      parts.unshift(selectorStep(node));
      if (unique(parts.join(' > '))) break;
    }
    return parts.join(' > ');
  }

  const domPath = (el) => {
    const out = [];
    for (let n = el; n && n.nodeType === 1 && !isPage(n) && out.length < 8; n = n.parentElement) {
      const id = n.id ? `#${n.id}` : '';
      const cls = ownClasses(n).find(distinctClass);
      out.unshift(n.localName + id + (!id && cls ? `.${cls}` : ''));
    }
    return out.join(' > ');
  };

  const rectOf = (r) => ({
    x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
  });

  /** Compact one-line identity used for the elements listed inside a region. */
  function brief(el) {
    const r = el.getBoundingClientRect();
    const testid = el.getAttribute('data-testid');
    let tag = el.localName;
    const cls = ownClasses(el).find(distinctClass);
    if (el.id) tag += `#${el.id}`;
    else if (cls) tag += `.${cls}`;
    const isField = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    return {
      tag, testid: testid || undefined,
      selector: cssSelector(el),
      // An input has no innerText - its content is the value, which is what the user sees.
      text: clean(isField ? el.value : el.innerText || el.textContent, 80) || undefined,
      placeholder: isField ? el.placeholder || undefined : undefined,
      rect: rectOf(r),
    };
  }

  function describe(el) {
    const cs = getComputedStyle(el);
    // Prefer real outerHTML so the model sees the element's own text; fall back to a shallow
    // clone (open tag only) for big containers rather than dumping half the page.
    const full = el.outerHTML;
    const html = full.length <= MAX_HTML
      ? full
      : el.cloneNode(false).outerHTML.slice(0, MAX_HTML) + ' <!-- truncated -->';
    return {
      kind: 'element',
      selector: cssSelector(el),
      path: domPath(el),
      testid: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || undefined,
      role: el.getAttribute('role') || undefined,
      label: el.getAttribute('aria-label') || el.getAttribute('title') || undefined,
      text: clean(el.innerText || el.textContent) || undefined,
      html,
      rect: rectOf(el.getBoundingClientRect()),
      styles: {
        color: cs.color,
        background: cs.backgroundColor,
        font: `${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily.split(',')[0]}`,
        display: cs.display,
      },
    };
  }

  /**
   * Everything a region drag could catch, measured once when the drag starts. The page is frozen
   * while it runs, so walking and measuring the whole DOM again on every mousemove bought nothing.
   */
  function regionCandidates() {
    const out = [];
    for (const node of document.body?.querySelectorAll('*') || []) {
      if (isOurs(node) || /^(SCRIPT|STYLE|META|LINK|TITLE|BR|NOSCRIPT)$/.test(node.tagName)) continue;
      const r = node.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push({ node, r });
    }
    return out;
  }

  /**
   * A drag selects the anchors inside the box, not the box itself: every element fully
   * contained in it, reduced to the outermost ones so a card reports as one entry rather
   * than as its forty descendants. Over a PDF or canvas nothing qualifies and the caller
   * falls back to the plain rect, which is what makes that case still work.
   */
  function elementsInRegion(rect, candidates, limit = REGION_MAX_ELEMENTS) {
    const pad = 2;
    /**
     * `visibility` inherits, so a hidden subtree drops out on each node's own style. `opacity`
     * does not: a child of an `opacity:0` container computes to 1, and losing the container to
     * the filter promotes its children to outermost - a closed dropdown or a faded-out toast
     * reported as if it were on the screen. So the answer is memoised per call: every ancestor
     * is measured once for the whole region, not once per candidate, and since candidates come
     * in document order the walk usually stops on the parent's cached answer. This runs on every
     * mousemove of a drag, over everything inside the box.
     */
    const gone = new Map();
    const faded = (el) => {
      if (!el) return false;
      let out = gone.get(el);
      if (out === undefined) {
        // Numerically: '0.001' is not '0' as a string either, and only a 0 is invisible.
        out = parseFloat(getComputedStyle(el).opacity) === 0 || faded(el.parentElement);
        gone.set(el, out);
      }
      return out;
    };
    const hits = candidates.filter(({ node, r }) => {
      if (r.left < rect.x - pad || r.top < rect.y - pad) return false;
      if (r.right > rect.x + rect.w + pad || r.bottom > rect.y + rect.h + pad) return false;
      const cs = getComputedStyle(node); // only for what is inside, which is few
      if (cs.visibility === 'hidden') return false;
      const out = parseFloat(cs.opacity) === 0 || faded(node.parentElement);
      gone.set(node, out); // the style is already in hand; descendants reuse it
      return !out;
    }).map((c) => c.node);

    const set = new Set(hits);
    const outermost = hits.filter((n) => {
      for (let p = n.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
      return true;
    });
    return outermost.slice(0, limit);
  }

  // ---------------------------------------------------------------- console capture
  // Recorded by console-hook.js, which runs in the page world where the page's console is.
  const consoleErrors = [];
  window.addEventListener('cc:console', (e) => {
    if (typeof e.detail !== 'string') return;
    consoleErrors.push(e.detail);
    while (consoleErrors.length > 5) consoleErrors.shift();
  });

  // ---------------------------------------------------------------- UI
  const ACCENT = '#6366f1'; // the tool itself: button, popover, cursors
  // Red is reserved for what has to be seen at a glance: the ring burned into the screenshot,
  // which has to survive being looked at out of context, and the count badge. Everything else
  // on the live page is the one accent.
  const RING = '#ff3b30';
  const LOST = '#f5a524'; // a comment whose anchor is not on the page

  /**
   * Viscous, not springy. A damped spring overshoots and reads as a bounce; this is a heavy
   * ease-in-out instead - 0.7% of the distance covered in the first 10% of the time, so the
   * box visibly resists leaving the element it was on, then is pulled across and settles
   * without ever passing the target. Zero overshoot is what separates "stuck to it" from
   * "bounced onto it".
   */
  const STICK = 'cubic-bezier(0.75, 0, 0.22, 1)';
  const MOVE_MS = 280;
  /**
   * The entrance is a different gesture from the move and gets a different curve. Moving is
   * viscous because the box has to look reluctant to let go of what it was on; appearing has
   * nothing to let go of, so the same slow start would just read as lag. This one leaves at
   * once and eases into place, still without overshoot.
   */
  const OPEN = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const OPEN_MS = 200;
  /**
   * Leaving is not arriving played backwards. An entrance eases in because it is asking to be
   * noticed; an exit accelerates away because it is done being looked at - and it is shorter,
   * since nothing has to be read off it. What it must not be is instant: a box that vanishes
   * between two frames reads as a glitch in the page rather than as the tool letting go.
   */
  const EXIT = 'cubic-bezier(0.4, 0, 1, 1)';
  const EXIT_MS = 130;
  /** How long the overlay takes to step out of, and back into, its own screenshot. */
  const VEIL_MS = 110;
  /**
   * How long the pointer must settle on a new target before the outline follows it. Without
   * this the outline chases every element swept over on the way somewhere, which reads as
   * twitchy no matter how nice the easing is - the box has to look reluctant to let go, not
   * just slow to arrive. Short enough to feel like intent, not lag.
   */
  const DWELL_MS = 35;
  const host = document.createElement('div');
  host.id = 'cc-overlay-host';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  // Closed, so a script on the page cannot reach into the panel through `host.shadowRoot` - fill
  // in the textarea, click Send - and have that leave as the user's comment.
  const sr = host.attachShadow({ mode: 'closed' });
  sr.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }

  /* The dock is a wide invisible catch zone; the tab itself sits mostly off-screen until
     the pointer nears the edge, so it never competes with the page it is annotating. */
  .dock { position:fixed; right:0; bottom:22px; padding:14px 0 14px 30px; pointer-events:auto; }
  .fab { width:38px; height:40px; border:0; cursor:pointer; display:grid; place-items:center;
    background:#17171b; color:#fff; border-radius:11px 0 0 11px; opacity:.22;
    transform:translateX(46%); box-shadow:-1px 0 0 #ffffff1f inset, 0 4px 14px #00000038;
    transition:transform .18s cubic-bezier(.2,.7,.3,1), opacity .18s ease, background .15s ease; }
  /* Every state is a change of tone, never an added edge: a ring drawn around the tab reads as
     a second shape appearing rather than the same one changing.
     At rest the tab is black and white, so it never competes with the page. Comment mode is
     the accent - white was tried and is close to invisible on a light page, which is exactly
     where this has to be unmissable. The hover and press tones are mixed from the accent
     rather than hand-picked, so they cannot drift away from it.
     Nearing the dock slides the tab out; only the tab itself under the pointer changes its tone -
     the list button shares the dock, and pointing at it says nothing about this one. */
  .dock:hover .fab { transform:translateX(0); opacity:1; }
  .fab:hover { background:#34343d; }
  .fab:active { transform:translateX(0) scale(.94); background:#0b0b0e; }
  .fab.on { transform:translateX(0); opacity:1; background:${ACCENT}; color:#fff; }
  .fab.on:hover { background:color-mix(in srgb, ${ACCENT} 80%, #fff); }
  .fab.on:active { background:color-mix(in srgb, ${ACCENT} 86%, #000); }

  /* The glyph inside the tab is the comment marker itself - the same teardrop a sent comment
     leaves on the page, as an empty ring. The count lives on the list button above it. */
  .mark { width:20px; height:20px; border-radius:50% 50% 50% 3px;
    box-shadow:inset 0 0 0 2px #ffffffdb; transition:box-shadow .15s ease; }
  .fab.on .mark { box-shadow:inset 0 0 0 2px #ffffffe6; }

  /* The list's switch. It exists only in comment mode, sliding out above the tab once the tool
     is armed - and that is the whole of the link between the two: opening or closing the list
     never changes the mode or the tab. Positioned out of the dock's flow: hidden, it must not
     widen the dock's catch zone over the page. */
  .lsbtn { position:absolute; right:0; bottom:calc(100% - 6px); width:38px; height:40px; border:0;
    padding:0; cursor:pointer; display:grid; place-items:center; background:#17171b; color:#fff;
    border-radius:11px 0 0 11px; box-shadow:-1px 0 0 #ffffff1f inset, 0 4px 14px #00000038;
    opacity:0; visibility:hidden; pointer-events:none; transform:translateX(105%);
    transition:transform .18s cubic-bezier(.2,.7,.3,1), opacity .18s ease, background .15s ease,
      visibility 0s linear .18s; }
  /* inherit, not visible: an explicit visible would survive the host being hidden for a screenshot. */
  .lsbtn.on { opacity:1; visibility:inherit; pointer-events:auto; transform:translateX(0);
    transition:transform .18s cubic-bezier(.2,.7,.3,1), opacity .18s ease, background .15s ease; }
  .lsbtn:hover { background:#34343d; }
  .lsbtn.open { background:color-mix(in srgb, ${ACCENT} 42%, #17171b); }
  .lsbtn.open:hover { background:color-mix(in srgb, ${ACCENT} 56%, #17171b); }
  /* An unread badge, the way a messaging app shows one: red, white figures, a white rim that cuts
     it out of whatever is behind. On the left corner - the right one is off the screen edge. */
  .badge { position:absolute; top:-6px; left:-8px; min-width:18px; height:18px; padding:0 5px;
    border-radius:9px; background:${RING}; color:#fff; font-size:11px; font-weight:700;
    line-height:18px; text-align:center; font-variant-numeric:tabular-nums;
    box-shadow:0 0 0 2px #fff, 0 1px 4px #0000004d; display:none; }
  .badge.on { display:block; }

  /* Every comment left on this page, found or not. Beside the dock it is switched from, and the
     same dark card as the panel. A comment whose anchor is gone has no pin, so this is the only
     way back to it - its row carries an icon instead of the number, and a warm tint. */
  .side { position:fixed; right:50px; bottom:36px; width:min(320px, calc(100vw - 62px));
    max-height:calc(100vh - 48px); display:flex; flex-direction:column; background:#17171b;
    color:#f2f2f4; border-radius:11px; box-shadow:0 12px 38px #00000073, 0 0 0 1px #ffffff17;
    pointer-events:auto; opacity:0; visibility:hidden; translate:8px 0;
    transition:opacity ${EXIT_MS}ms ${EXIT}, translate ${EXIT_MS}ms ${EXIT}, visibility 0s linear ${EXIT_MS}ms; }
  .side.on { opacity:1; visibility:inherit; translate:0 0;
    transition:opacity ${OPEN_MS}ms ${OPEN}, translate ${OPEN_MS}ms ${OPEN}; }
  .side-head { display:flex; align-items:center; gap:10px; padding:8px 8px 0 14px; }
  .side-title { font-size:13px; font-weight:600; }
  /* Closing the list is its own act, here in its corner, as on the panel. It is also the only way
     to close it once comment mode is off, since the list button goes with the mode. */
  .side-head .ico { margin-left:-4px; }
  .side-page { flex:1; min-width:0; text-align:right; font:11.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;
    color:#8a8a95; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .side-note { padding:0 14px 8px; font-size:12px; color:#8a8a95; }
  .side-note .gone { color:${LOST}; }
  .side-list { overflow:auto; overscroll-behavior:contain; padding:0 6px 6px; }
  .side-empty { display:none; padding:4px 14px 16px; font-size:13px; color:#8a8a95; }
  .side-empty.on { display:block; }
  .item { display:flex; gap:10px; align-items:flex-start; width:100%; border:0; margin:0;
    padding:9px 8px; border-radius:8px; background:transparent; color:inherit; text-align:left;
    cursor:pointer; transition:background .13s ease; }
  .item:hover { background:#ffffff0f; }
  /* A clicked row keeps focus, and the next key - Esc closing the panel - would put the
     browser's own ring on it. A keyboard user still gets one, in the panel's own tone. */
  .item, .lsbtn { outline:none; }
  .item:focus-visible { box-shadow:inset 0 0 0 1.5px #ffffff3d; }
  .item.active { background:${ACCENT}33; }
  .item.lost { background:${LOST}14; }
  .item.lost:hover { background:${LOST}24; }
  .item.lost.active { background:${LOST}33; }
  .item-mark { flex:none; width:22px; height:22px; margin-top:1px; border-radius:50% 50% 50% 3px;
    display:grid; place-items:center; background:${ACCENT}; color:#fff; font-size:11px;
    font-weight:700; font-variant-numeric:tabular-nums; }
  .item.lost .item-mark { background:${LOST}2e; color:${LOST}; }
  .item-body { flex:1; min-width:0; }
  .item-text { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden;
    font-size:13.5px; line-height:1.45; overflow-wrap:anywhere; }
  .item-meta { display:block; margin-top:2px; font-size:12px; line-height:1.4; color:#8a8a95;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

  /* Element and text hovers are mutually exclusive: exactly one is ever shown, since a click
     and a drag from the same spot do different things and showing both would promise two
     outcomes at once. */
  /* left/top stay at 0 and movement is done with translate: it is a compositor property,
     so following the pointer costs no layout on the page underneath. */
  /* The ring sits entirely OUTSIDE the element's own box - an outline plus an offset rather
     than a border, which is drawn inside it and covers whatever runs to the edge: a field's
     own border, an icon, text with no padding.
     Soft on purpose. It was a 2.5px line of full-strength accent between two hard concentric
     bands - white, then a dark hairline - which read as a sticker pasted over the page rather
     than the page being pointed at. Now: a thinner line at three-quarter strength, so it is
     the same colour said quietly; a wider radius; and the two bands replaced by blurred
     glows. The white one still does its real job - separating the line from busy or dark
     content - but as a halo rather than an edge of its own. */
  .hl { position:fixed; left:0; top:0; pointer-events:none;
    border-radius:3px; background:${ACCENT}0d;
    outline:2.5px solid ${ACCENT}b8; outline-offset:3px;
    box-shadow:0 0 7px 2px #ffffff96, 0 0 18px 2px ${ACCENT}29; }
  .hl.move { transition: translate ${MOVE_MS}ms ${STICK}, width ${MOVE_MS}ms ${STICK},
    height ${MOVE_MS}ms ${STICK}; }
  /* A box that has just appeared opens out from its own centre on both axes rather than
     snapping into existence. Width/height/translate rather than scale, so the ring keeps its
     weight all the way through - a scaled box has visibly thinner sides while it animates.
     The fade is what stops the first frames reading as a flash: a box with no size is still a
     visible knot of outline, and at full opacity that knot is a mark that appears before the
     box does. Linear, so opacity trails the front-loaded geometry curve and the frames where
     there is nothing but outline are the frames that cannot be seen. */
  .hl.open { transition: translate ${OPEN_MS}ms ${OPEN}, width ${OPEN_MS}ms ${OPEN},
    height ${OPEN_MS}ms ${OPEN}, opacity ${OPEN_MS}ms linear; }
  /* The entrance in reverse, and quicker: the box collapses back onto the centre of whatever it
     was pointing at instead of being deleted out from under the pointer. Opacity finishes first,
     so the last frames - where a zero-sized box is nothing but a knot of outline - are already
     invisible. Dying boxes animate in their own container: the live ones are reused by index,
     and one left in that pool would be picked up and reanimated as the next hover. */
  .hl.gone { opacity:0;
    transition: translate ${EXIT_MS}ms ${EXIT}, width ${EXIT_MS}ms ${EXIT},
      height ${EXIT_MS}ms ${EXIT}, opacity ${Math.round(EXIT_MS * 0.75)}ms linear; }
  @media (prefers-reduced-motion: reduce) {
    .hl.move, .hl.open, .hl.gone { transition: none; }
    .pop, .pop.leave, .lsbtn, .side, .scrim { transition: none; }
    .pin.in { animation: none; }
  }
  /* A confirmed text selection is tinted, not boxed - a border would read as the element
     outline, which is precisely the thing this is not. */
  .hl.text { border-radius:2px; background:${ACCENT}3d; outline:0; box-shadow:none; }
  /* Hovering text tints the word under the pointer - the single character where the writing
     system does not separate words. A blinking caret was tried first and sat directly beneath
     the mouse pointer, which covered it: the one thing meant to show you where you are was the
     one thing you could not see. Lighter than a confirmed selection, since it is only a hover. */
  .hl.text.word { background:${ACCENT}2e; }
  /* All that is left of the label: the count of anchors a drag is about to capture. The
     hover label is gone - the outline already says what is under the pointer. */
  .tag { position:fixed; left:0; top:0; pointer-events:none; background:${ACCENT}; color:#fff; font-size:11px;
    font-weight:600; padding:2px 6px; border-radius:4px; white-space:nowrap; display:none;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace; box-shadow:0 2px 6px #0000003d; }
  .tag.on { display:block; }
  /* While a comment is being written the page takes no clicks, and this says so: a faint scrim over
     everything but the anchor, cut out a little wider than its ring so the anchor stays at full
     strength. One box whose shadow is the scrim, so the cutout is just where the box is. It only
     shows the freeze - the freeze does the blocking - so the pointer passes straight through. */
  /* While a comment is being written, the pointer belongs to the panel and not to the page.
     Stopping events is not enough for that: a magnifier, a zoom-on-hover image or any other
     effect driven by a CSS :hover rule has no listener to stop, and fires under a pointer that is
     only on its way to the textarea. This takes the pointer instead - one transparent layer
     over everything, so nothing underneath is hovered at all. It is up only while composing,
     never while picking, where hit-testing the page is the entire job. Scrolling is unaffected:
     the layer is not scrollable, so a wheel over it scrolls the page as before. */
  .shield { position:fixed; inset:0; display:none; pointer-events:auto; cursor:default; }
  .shield.on { display:block; }
  .scrim { position:fixed; left:0; top:0; pointer-events:none; border-radius:7px; opacity:0;
    box-shadow:0 0 0 200vmax rgba(12,12,18,.14); transition:opacity ${EXIT_MS}ms ${EXIT}; }
  .scrim.on { opacity:1; transition:opacity ${OPEN_MS}ms ${OPEN}; }
  /* While the frame for a just-picked anchor is taken: everything steps aside except the outline. */
  :host(.cc-capturing) :is(.pop, .scrim, .pins, .dock, .side, .ghosts, .tag, .band) { visibility:hidden !important; }
  .band { position:fixed; pointer-events:none; border:1.5px dashed ${ACCENT}9e; border-radius:4px;
    background:${ACCENT}0f; box-shadow:0 0 6px 1px #ffffff8f; display:none; }
  .band.on { display:block; }

  .pop { position:fixed; width:400px; background:#17171b; color:#f2f2f4; border-radius:11px;
    box-shadow:0 12px 38px #00000073, 0 0 0 1px #ffffff17; padding:13px; pointer-events:auto;
    display:none; translate:0 0;
    transition: opacity ${EXIT_MS}ms ease, translate ${EXIT_MS}ms ease; }
  .pop.on { display:block; }
  /* Applied for one frame with the transition off, so removing it is what animates. The panel
     rises the last few pixels into place rather than being switched on. */
  .pop.enter { opacity:0; translate:0 7px; transition:none; }
  /* The "on" class outlives "leave" by the length of the animation - the panel has to still be
     displayed while it goes. Everything that asks whether a comment is being written therefore
     has to discount a panel that is already leaving, or the tool stays lit for a beat after it
     is over. */
  .pop.leave { opacity:0; translate:0 5px; pointer-events:none;
    transition: opacity ${EXIT_MS}ms ${EXIT}, translate ${EXIT_MS}ms ${EXIT}; }
  /* Controls belong in the corner, not in the content. Close and Delete were full-width-ish
     text buttons sharing the footer with Send, which made three things of equal weight out of
     one action, one dismissal and one destruction - and, on the read-back, gave a panel whose
     entire job is to show a sentence a footer bigger than the sentence. */
  .head { display:flex; align-items:center; gap:3px; margin-bottom:9px; }
  .what { flex:1; min-width:0; font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;
    color:#8a8a95; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ico { flex:none; width:27px; height:27px; display:grid; place-items:center; border:0;
    padding:0; border-radius:7px; background:transparent; color:#9b9ba6; cursor:pointer;
    transition:background .13s ease, color .13s ease; }
  .ico svg { display:block; }
  .ico:hover { background:#ffffff14; color:#f2f2f4; }
  .ico:disabled { opacity:.35; cursor:default; background:transparent; }
  /* The handle sits apart from the two buttons that DO something, so reaching for "move" can
     never land on "delete". touch-action off, or the browser scrolls the page instead. */
  .ico.grip { cursor:grab; touch-action:none; margin-right:1px; }
  .pop.dragging .ico.grip { cursor:grabbing; background:#ffffff14; color:#f2f2f4; }
  .pop.dragging { user-select:none; }
  /* Only where there is something to delete, and it asks once before it acts: the icon turns
     red and the line underneath says what a second click will do. Keeping it an icon means the
     panel does not grow a confirmation dialog to remove one marker. */
  .ico.del { display:none; }
  .pop.viewing .ico.del { display:grid; }
  .ico.del:hover { background:#ff6b6b1f; color:#ff9d95; }
  .ico.del.arm { background:#ff6b6b33; color:#ffb0a8; }

  /* Every scrolling surface in the overlay, drawn the same way: the comment being written, the
     quote above it, a comment read back, the list of them, the Slack picker.

     Chrome's default scrollbar lays a light track down the side of a dark panel, which makes it
     the brightest thing in the panel and leaves it there whether or not anything can scroll. This
     is an overlay scrollbar instead - no track, and a thumb that only appears while the surface
     is being used. The thumb is inset with a transparent border and background-clip, so it
     floats over the content rather than sitting in a gutter. Firefox gets the same in the two
     properties it has. */
  textarea, .quoted, .said, .dlist, .side-list {
    scrollbar-width:thin; scrollbar-color:transparent transparent; }
  /* :focus-within covers the textarea itself - it matches an element that holds the focus. */
  :is(textarea, .quoted, .said, .dlist, .side-list):hover,
  :is(textarea, .quoted, .said, .dlist, .side-list):focus-within { scrollbar-color:#ffffff3d transparent; }
  :is(textarea, .quoted, .said, .dlist, .side-list)::-webkit-scrollbar { width:10px; height:10px; }
  :is(textarea, .quoted, .said, .dlist, .side-list)::-webkit-scrollbar-track { background:transparent; }
  :is(textarea, .quoted, .said, .dlist, .side-list)::-webkit-scrollbar-thumb {
    background:transparent; border-radius:10px; border:3px solid transparent;
    background-clip:content-box; }
  :is(textarea, .quoted, .said, .dlist, .side-list):hover::-webkit-scrollbar-thumb,
  :is(textarea, .quoted, .said, .dlist, .side-list):focus-within::-webkit-scrollbar-thumb {
    background:#ffffff33; background-clip:content-box; }
  :is(textarea, .quoted, .said, .dlist, .side-list)::-webkit-scrollbar-thumb:hover {
    background:#ffffff59; background-clip:content-box; }
  /* The corner where two scrollbars would meet is a light square by default. */
  :is(textarea, .quoted, .said, .dlist, .side-list)::-webkit-scrollbar-corner { background:transparent; }
  .quoted { display:none; margin:0 0 9px; padding:7px 10px; border-left:2px solid ${ACCENT};
    background:#ffffff0a; border-radius:0 5px 5px 0; font-size:13.5px; line-height:1.55;
    color:#cfcfd8; max-height:112px; overflow:auto; }
  .quoted.on { display:block; }
  textarea { width:100%; height:132px; min-height:80px; resize:vertical; background:#0e0e11;
    color:#f2f2f4; border:1px solid #ffffff1c; border-radius:7px; padding:10px 11px;
    font-size:14.5px; line-height:1.55; outline:none; }
  textarea:focus { border-color:${ACCENT}; }
  .row { display:flex; align-items:center; gap:8px; margin-top:9px; }
  .sp { flex:1; }
  .btn { position:relative; border:0; border-radius:7px; padding:7px 15px; font-size:13px;
    font-weight:600; cursor:pointer; background:${ACCENT}; color:#fff; }
  /* Slack is a second destination, not a second Send, so it is outlined rather than filled -
     one primary action in the row, and this next to it. */
  .btn.outline { display:inline-flex; align-items:center; gap:6px; background:transparent;
    border:1px solid #ffffff2b; color:#dcdce4; }
  .btn.outline:hover { background:#ffffff0f; border-color:#ffffff47; }
  .btn.outline svg { display:block; flex:none; }
  /* The spinner draws over the label, and the icon has to go with it. */
  .btn.outline.busy svg { visibility:hidden; }
  .btn:disabled { opacity:.5; cursor:default; }
  /* The panel stays put while sending and closes only once the comment is actually in the
     session - the button carries the wait, so there is nothing to catch after the fact. */
  .btn.busy { color:transparent; opacity:1; }
  .btn.busy::after { content:''; position:absolute; inset:0; margin:auto; width:12px; height:12px;
    border:2px solid #ffffff5c; border-top-color:#fff; border-radius:50%;
    animation:spin .62s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .shot { display:flex; align-items:center; gap:5px; font-size:12px; color:#9b9ba6;
    cursor:pointer; user-select:none; }
  .shot.auto { cursor:default; }
  .shot.auto input { display:none; }
  .shot.failed { color:#ff8f88; }
  .hint { margin-top:7px; font-size:12px; color:#8a8a95; }
  .pop.viewing .hint { margin-top:10px; }
  .status { margin-top:7px; font-size:12px; color:#ff8f88; display:none; }
  .status.on { display:block; }
  /* Sending somewhere is not a failure, and the line that reports both cannot read as one. */
  .status.ok { color:#86d19a; }

  /* Where in Slack this goes. It opens inside the panel rather than over the page: picking a
     channel is part of writing the comment, and a second floating layer would be one more
     thing covering what is being commented on. Bounded height, so the panel grows by a known
     amount and the placement it was given still holds. */
  .dest { display:none; margin-top:9px; padding:6px; border:1px solid #ffffff26;
    border-radius:9px; background:#121216; }
  .dest.on { display:block; }
  .destq { width:100%; background:#0b0b0e; color:#f2f2f4; border:1px solid #ffffff21;
    border-radius:7px; padding:7px 10px; font:13px/1.5 inherit; outline:none; }
  .destq::placeholder { color:#75757f; }
  .destq:focus { border-color:${ACCENT}; }
  .dlist { max-height:196px; overflow-y:auto; overflow-x:hidden; margin-top:6px; }
  .drow { display:flex; align-items:baseline; gap:7px; width:100%; text-align:left; border:0;
    background:transparent; color:#d8d8e0; font:13px/1.5 inherit; padding:6px 8px;
    border-radius:6px; cursor:pointer; }
  /* The sigil is the kind: a channel, a private channel, a person. Dim, because the name is
     what is being read - but it is what the # and @ in the search box filter on. */
  .dsig { flex:none; width:11px; color:#7b7b86; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .dname { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .drow:hover, .drow.sel { background:#ffffff14; color:#f2f2f4; }
  .drow.sel .dsig { color:#b9b9c4; }
  .dnote { padding:7px 8px; font-size:12px; color:#8a8a95; }

  /* Read-back of a sent comment. Same panel, same place - only the compose parts drop out.
     The comment is the whole point of this panel, so it is the largest thing in it and the only
     one at full contrast. It used to sit in a bordered dark box, which read as a disabled
     textarea - the shape of something you were not allowed to edit rather than the shape of
     something to read. Everything else recedes: the anchor label is mono and dim, the sent
     time smaller still, the controls are icons in the corner. */
  .said { display:none; white-space:pre-wrap; font-size:15.5px; line-height:1.62; color:#f4f4f7;
    max-height:250px; overflow:auto; }
  .pop.viewing .said { display:block; }
  .pop.viewing textarea, .pop.viewing .quoted, .pop.viewing .row { display:none; }

  /* A pin and the tab's glyph are the same marker: same circle, same colour, same weight.
     Faded out of comment mode, lit while in it, full on hover. */
  @keyframes pinin { from { scale:.4; } 62% { scale:1.1; } to { scale:1; } }
  .pin.in { animation:pinin 280ms cubic-bezier(.3,.85,.35,1); }
  .pin { position:fixed; width:24px; height:24px; border-radius:50% 50% 50% 3px; border:0; padding:0;
    display:grid; place-items:center; background:${ACCENT}; color:#fff; font:700 11.5px/1 inherit;
    font-family:inherit; font-variant-numeric:tabular-nums; cursor:pointer; pointer-events:auto;
    opacity:.3; box-shadow:0 2px 8px #0000004d, inset 0 0 0 1.5px #ffffff2e;
    transition:opacity .16s ease, scale .12s ease; }
  .pin:hover { opacity:1; scale:1.14; }
  .pins.lit .pin { opacity:.9; }
  /* Turned off in the menu: out of comment mode, only a pin being read back is shown. */
  .pins.quiet:not(.lit) .pin:not(.active) { opacity:0; pointer-events:none; }
  .pin.active { opacity:1; box-shadow:0 0 0 3.5px ${ACCENT}52, 0 2px 8px #0000004d,
    inset 0 0 0 1.5px #ffffff2e; }
</style>
<div class="shield"></div>
<div class="scrim"></div>
<div class="band"></div>
<div class="hls"></div>
<div class="ghosts"></div>
<div class="tag"></div>
<div class="pins quiet"></div>
<div class="side">
  <div class="side-head">
    <span class="side-title">Comments</span><span class="side-page"></span>
    <button class="ico side-close" title="Close the list">
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
           stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
    </button>
  </div>
  <div class="side-note"></div>
  <div class="side-list"></div>
  <div class="side-empty">Nothing has been sent from this page yet.</div>
</div>
<div class="dock">
  <button class="lsbtn" title="Comments on this page" aria-expanded="false">
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
         stroke-width="1.5" stroke-linecap="round"><path d="M6.5 4h7M6.5 8h7M6.5 12h7"/><path
         d="M2.8 4h.01M2.8 8h.01M2.8 12h.01" stroke-width="2.2"/></svg>
    <span class="badge"></span>
  </button>
  <button class="fab" title="Comment on this page (c)"><span class="mark"></span></button>
</div>
<div class="pop">
  <div class="head">
    <button class="ico grip" title="Drag to move this panel">
      <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><circle cx="6" cy="4"
        r="1.35"/><circle cx="10" cy="4" r="1.35"/><circle cx="6" cy="8" r="1.35"/><circle
        cx="10" cy="8" r="1.35"/><circle cx="6" cy="12" r="1.35"/><circle cx="10" cy="12"
        r="1.35"/></svg>
    </button>
    <div class="what"></div>
    <button class="ico del" title="Delete this comment">
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
           stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path
           d="M3 4.5h10M6.4 4.5V3h3.2v1.5M4.8 4.5l.5 8.2h5.4l.5-8.2M6.7 6.8v3.6M9.3 6.8v3.6"/></svg>
    </button>
    <button class="ico close" title="Close (Esc)">
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
           stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
    </button>
  </div>
  <blockquote class="quoted"></blockquote>
  <div class="said"></div>
  <textarea placeholder="What should change here?" spellcheck="false"></textarea>
  <div class="dest">
    <input class="destq" type="text" placeholder="channel用#開頭 私訊用@開頭" spellcheck="false">
    <div class="dlist"></div>
  </div>
  <div class="row">
    <label class="shot"><input type="checkbox" class="shotbox"> <span class="shottext">screenshot</span></label>
    <span class="sp"></span>
    <button class="btn outline slack" hidden>
      <svg viewBox="0 0 122 122" width="13" height="13" aria-hidden="true"><path fill="#E01E5A"
        d="M25.8 77.6a12.9 12.9 0 1 1-12.9-12.9h12.9v12.9Zm6.5 0a12.9 12.9 0 0 1 25.8 0v32.3a12.9
        12.9 0 0 1-25.8 0V77.6Z"/><path fill="#36C5F0" d="M45.2 25.8a12.9 12.9 0 1 1 12.9-12.9v12.9H45.2Zm0
        6.5a12.9 12.9 0 0 1 0 25.8H12.9a12.9 12.9 0 0 1 0-25.8h32.3Z"/><path fill="#2EB67D"
        d="M96.9 45.2a12.9 12.9 0 1 1 12.9 12.9H96.9V45.2Zm-6.5 0a12.9 12.9 0 0 1-25.8
        0V12.9a12.9 12.9 0 0 1 25.8 0v32.3Z"/><path fill="#ECB22E" d="M77.6 96.9a12.9 12.9 0 1 1-12.9
        12.9V96.9h12.9Zm0-6.5a12.9 12.9 0 0 1 0-25.8h32.3a12.9 12.9 0 0 1 0 25.8H77.6Z"/></svg>
      <span>Slack</span>
    </button>
    <button class="btn send">Send</button>
  </div>
  <div class="hint"></div>
  <div class="status"></div>
</div>`;
  (document.body || document.documentElement).appendChild(host);
  const $ = (s) => sr.querySelector(s);
  const el = {
    fab: $('.fab'), hls: $('.hls'), ghosts: $('.ghosts'), tag: $('.tag'), band: $('.band'), scrim: $('.scrim'), shield: $('.shield'),
    pop: $('.pop'), what: $('.what'), quoted: $('.quoted'), ta: $('textarea'),
    send: $('.send'), close: $('.close'), del: $('.del'), grip: $('.grip'),
    hint: $('.hint'), pins: $('.pins'),
    shotbox: $('.shotbox'), shotLabel: $('.shot'), shotText: $('.shottext'), said: $('.said'),
    slack: $('.slack'), dest: $('.dest'), destq: $('.destq'), dlist: $('.dlist'),
    status: $('.status'), lsbtn: $('.lsbtn'), badge: $('.badge'),
    side: $('.side'), sidePage: $('.side-page'), sideNote: $('.side-note'), sideClose: $('.side-close'),
    sideList: $('.side-list'), sideEmpty: $('.side-empty'),
  };

  /**
   * `hlSource` is the locator of whatever is outlined - the element under the pointer, the anchor
   * being written about, or the pin being read back. All are the same record; see `locatorFor`.
   */
  const state = { picking: false, anchor: null, drag: null, wantShot: false, busy: false,
                  hlSource: null, target: null, dwell: null, viewing: null,
                  word: null, fresh: null, popAt: null, listOpen: false, keepMode: false };

  /** How a page is identified: path and query, never the hash - which is where `#cc=` lives. */
  const pageKey = () => location.pathname + location.search;

  /** The origin was turned off from the toolbar menu while this page was open - see `setSwitchedOff`. */
  let switchedOff = false;

  /** `c` arms the tool only on local pages - see the keydown handler. */
  const SHORTCUT = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  /** The only feedback channel left, and it lives inside the panel that caused it. */
  const setStatus = (msg, ok = false) => {
    el.status.textContent = msg || '';
    el.status.classList.toggle('on', Boolean(msg));
    el.status.classList.toggle('ok', Boolean(msg) && ok);
  };

  /**
   * With the extension the capture is silent, so it is simply always on and the checkbox
   * would be noise. Without it the only route is getDisplayMedia, which prompts to share the
   * tab on every send - that stays opt-in rather than ambushing the user mid-comment.
   */
  let shotAuto = false;

  /** `err` null restores the normal line; a message pins the failure to it until it works. */
  function markShot(err) {
    if (!shotAuto) return;
    el.shotLabel.classList.toggle('failed', Boolean(err));
    el.shotText.textContent = err ? 'no screenshot' : 'screenshot attached';
    el.shotLabel.title = err || 'Captured by the extension - no prompt';
  }

  hasExtension().then((ok) => {
    shotAuto = ok;
    el.shotLabel.classList.toggle('auto', ok);
    if (ok) markShot(captureError);
    else el.shotLabel.title = 'No extension: each send asks to share the tab';
  });
  el.shotbox.addEventListener('change', () => { state.wantShot = el.shotbox.checked; });

  // Offered only where the panel can reach Slack without the page reaching it too - see `cfg.slack`.
  if (cfg.slack) {
    el.slack.hidden = false;
    el.slack.title = cfg.slack.user ? `Post this to Slack as ${cfg.slack.user}` : 'Post this to Slack';
  }

  // ------------------------------------------------- caret probing
  /**
   * No overlay intercepts hit-testing any more, so this resolves straight to page text.
   * An earlier version put a full-screen capture layer in front and briefly dropped its
   * pointer-events to probe through it; with a real pointer that made the cursor flicker
   * between layers and, mid-drag, let the browser start its own native selection alongside
   * the scripted one - which is what dragged in unrelated text.
   */
  function caretAt(x, y) {
    try {
      if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
      if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y);
        if (pos) {
          const range = document.createRange();
          range.setStart(pos.offsetNode, pos.offset);
          range.collapse(true);
          return range;
        }
      }
    } catch {}
    return null;
  }

  /** A caret that actually lands on real page text - the signal for switching to text mode. */
  function textCaretAt(x, y) {
    const r = caretAt(x, y);
    const n = r?.startContainer;
    if (!n || n.nodeType !== 3) return null;
    if (isOurs(n.parentElement)) return null;
    const content = n.textContent || '';
    if (!/\S/.test(content)) return null;

    // A control's label is technically text, but nobody drags across a button to quote it -
    // they click it. Keep the I-beam off form controls so the affordance stays honest.
    const parent = n.parentElement;
    if (parent?.closest('button,input,select,textarea,[role="button"]')) return null;
    // Nor promise an I-beam where the page has forbidden selection - the drag would do nothing.
    if (parent) {
      const us = getComputedStyle(parent);
      if ((us.userSelect || us.webkitUserSelect) === 'none') return null;
    }

    // caretRangeFromPoint snaps to the NEAREST text, so a point out in blank space still comes
    // back with a caret. Require the pointer to actually sit on that character's line box,
    // otherwise empty margins would show an I-beam and swallow region drags.
    const probe = document.createRange();
    try {
      probe.setStart(n, Math.max(0, r.startOffset - 1));
      probe.setEnd(n, Math.min(content.length, r.startOffset + 1));
    } catch { return null; }
    const box = probe.getBoundingClientRect();
    if (!box.width && !box.height) return null;
    const pad = 6;
    if (x < box.left - pad || x > box.right + pad) return null;
    if (y < box.top - pad || y > box.bottom + pad) return null;
    return r;
  }

  /**
   * Words are separated in some writing systems and not in others, so the unit under the
   * pointer differs: a whole word in English or in code, a single character in Chinese and
   * Japanese. Punctuation and spaces fall through to one character too, so the tint always
   * has something to sit on.
   */
  const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;
  const WORDCH = /[\p{L}\p{N}_'\u2019-]/u;

  /**
   * A caret sits *between* two characters, so its offset alone does not say which one the
   * pointer is on. Measure both candidates and take the one whose box the pointer is inside.
   */
  function charIndexAt(node, text, offset, x) {
    for (const i of [offset, offset - 1]) {
      if (i < 0 || i >= text.length) continue;
      const r = document.createRange();
      try { r.setStart(node, i); r.setEnd(node, i + 1); } catch { continue; }
      const b = r.getBoundingClientRect();
      if (x >= b.left - 0.5 && x <= b.right + 0.5) return i;
    }
    return Math.min(Math.max(offset, 0), Math.max(0, text.length - 1));
  }

  /** The span the tint covers - the word around the pointer, or the single character - and its offsets. */
  function wordRangeAt(caret, x) {
    const node = caret.startContainer;
    const text = node.textContent || '';
    if (!text) return null;
    const i = charIndexAt(node, text, caret.startOffset, x);
    let start = i;
    let end = i + 1;
    if (WORDCH.test(text[i]) && !CJK.test(text[i])) {
      const wordy = (c) => c && WORDCH.test(c) && !CJK.test(c);
      while (start > 0 && wordy(text[start - 1])) start--;
      while (end < text.length && wordy(text[end])) end++;
    }
    const range = document.createRange();
    try { range.setStart(node, start); range.setEnd(node, end); } catch { return null; }
    return { range, key: `${start}:${end}` };
  }

  /**
   * Painted instantly, not on the dwell and not through the sticky transition: this is the
   * hover state for text, and a tint that glides after the pointer would be reporting the
   * word you were on rather than the one you are on.
   */
  function paintWord(caret, x) {
    const word = wordRangeAt(caret, x);
    const rects = word
      ? [...word.range.getClientRects()].filter((q) => q.width > 0 && q.height > 0)
      : [];
    if (!rects.length) {
      if (state.word) { state.word = null; clearHighlight(true); }
      return;
    }
    // Same word as the last move - the tint is already exactly where it belongs.
    if (state.word && state.word.node === caret.startContainer && state.word.key === word.key) return;
    state.word = { node: caret.startContainer, key: word.key };
    // The tint belongs to the pointer, not to a locator - a repaint must not bring back the
    // element outline it replaced.
    state.hlSource = null;
    paintHighlight(rects, 'word', true);
  }

  // ------------------------------------------------- pick mode
  /**
   * Both cursors are drawn rather than borrowed from the OS. A native crosshair next to a
   * native I-beam reads as two unrelated tools; these share one geometry - a white halo under
   * an accent stroke, same weights, same round caps - so switching between them reads as one
   * tool changing what it is pointing at.
   */
  const drawCursor = (paths, dot) => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">' +
      `<g fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round" opacity=".95">${paths}</g>` +
      `<g fill="none" stroke="${ACCENT}" stroke-width="2.6" stroke-linecap="round">${paths}</g>` +
      (dot ? `<circle cx="13" cy="13" r="1.5" fill="${ACCENT}"/>` : '') +
      '</svg>';
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 13 13`;
  };

  // The I-beam is drawn taller and heavier than the crosshair on purpose: it is the whole
  // affordance for text (nothing is outlined), so it has to be unmistakable at a glance.
  const CURSOR_PICK = drawCursor('<path d="M13 3.5v6M13 16.5v6M3.5 13h6M16.5 13h6"/>', true);
  const CURSOR_TEXT = drawCursor('<path d="M13 3.5v19M9 3.5h8M9 22.5h8"/>', false);

  // Cursors have to be forced onto page elements, which a shadow stylesheet cannot reach, so
  // this one sheet goes into the document and is switched by a class on <html>.
  //
  // While picking, embedded documents stop taking the pointer. A PDF viewer or an iframe is a
  // separate frame: its mouse events never reach this document, so a drag over the PDF a wrapper
  // page shows did nothing at all, and a click into an iframe went straight past the freeze.
  // With them transparent to the pointer, the drag lands here and becomes a plain region.
  const cursorSheet = document.createElement('style');
  cursorSheet.textContent =
    `html.cc-pick, html.cc-pick *{ cursor: ${CURSOR_PICK}, crosshair !important; }` +
    `html.cc-pick-text, html.cc-pick-text *{ cursor: ${CURSOR_TEXT}, text !important; }` +
    'html.cc-pick :is(embed, object, iframe){ pointer-events: none !important; }';
  (document.head || document.documentElement).appendChild(cursorSheet);

  const root = document.documentElement;

  const cancelDwell = () => { clearTimeout(state.dwell); state.dwell = null; };

  /** Forget whatever the pointer was over, without dropping out of comment mode. */
  function leaveTarget() {
    cancelDwell();
    if (!state.target && !state.word) return;
    state.word = null;
    state.target = null;
    root.classList.remove('cc-pick-text');
    clearHighlight();
  }

  /**
   * The panel is shown and not already on its way out. A leaving panel still carries "on" for the
   * length of its animation, and every decision - what Esc does, whether the page is frozen -
   * has to treat it as closed, or a second Esc inside that window closed it again instead of
   * leaving comment mode.
   */
  const panelOpen = () => el.pop.classList.contains('on') && !el.pop.classList.contains('leave');
  const composing = () => panelOpen() && !el.pop.classList.contains('viewing');
  /**
   * Composing counts as being in comment mode. Reading a comment back neither arms the tool nor
   * disarms it: a pin or a list row opened in comment mode stays in it (`keepMode`), and closing
   * the read-back goes back to picking; opened outside it, the page stays live. One definition,
   * used by both the things that follow from it: the dock button reports it - out and lit for the
   * whole interaction, since a tab sliding away mid-sentence reads as the tool having switched
   * itself off - and the page is frozen for exactly as long as it is true.
   */
  const inCommentMode = () => state.picking || composing() || Boolean(state.viewing && state.keepMode);

  const syncFab = () => {
    const on = inCommentMode();
    el.fab.classList.toggle('on', on);
    el.pins.classList.toggle('lit', on);
    el.lsbtn.classList.toggle('on', on);
    placeScrim();
  };

  const SCRIM_PAD = 7; // clear of the ring, which sits 3px outside the anchor and is 2.5px wide

  /**
   * Shown for exactly as long as a comment is being written, cut out around wherever the anchor
   * is drawn now - so it is called on every state change and with every repaint that moves the
   * outline. With nothing drawn (an anchor gone from under the panel) the cutout closes and the
   * whole page is dimmed, since the page is still not taking clicks.
   */
  function placeScrim() {
    const on = composing();
    el.scrim.classList.toggle('on', on);
    // The scrim shows the freeze; the shield is what makes it true for hover as well as clicks.
    el.shield.classList.toggle('on', on);
    if (!on) return;
    const a = anchorRectNow();
    Object.assign(el.scrim.style, a
      ? { translate: `${a.x - SCRIM_PAD}px ${a.y - SCRIM_PAD}px`, width: `${a.w + SCRIM_PAD * 2}px`, height: `${a.h + SCRIM_PAD * 2}px` }
      : { translate: '0px 0px', width: '0px', height: '0px' });
  }

  /**
   * Closed until asked for, every time the page loads - it is a way back to comments, not a view.
   * Independent of comment mode: neither turns the other on or off.
   */
  function setList(open) {
    state.listOpen = open;
    el.side.classList.toggle('on', open);
    el.lsbtn.classList.toggle('open', open);
    el.lsbtn.setAttribute('aria-expanded', String(open));
    renderPins();
  }

  /**
   * `instant` is for the one caller that is about to repaint the very box it is clearing:
   * confirming an anchor leaves picking, and letting that collapse the hover outline puts a
   * shrinking ghost on top of the identical outline the panel then draws.
   */
  function setPicking(on, instant) {
    state.picking = on;
    root.classList.toggle('cc-pick', on);
    cancelDwell();
    if (!on) {
      root.classList.remove('cc-pick-text');
      state.word = null;
      clearHighlight(instant);
      el.band.classList.remove('on');
      state.drag = null;
      state.target = null;
    }
    syncFab();
  }

  /**
   * The element under a point. Embedded frames ignore the pointer while picking (see the cursor
   * sheet), so hit-testing passes straight through them to whatever holds them - but the frame is
   * still what was pointed at, unless something that is not its ancestor sits on top of it.
   */
  function targetAt(x, y) {
    // Empty page is not a target: outlining <body> points at everything, which is pointing at nothing.
    const hit = document.elementsFromPoint(x, y).find((n) => !isOurs(n) && !isPage(n));
    const frame = [...document.querySelectorAll('iframe, embed, object')].find((f) => {
      const r = f.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    return frame && (!hit || hit.contains(frame)) ? frame : hit;
  }

  const place = (node, r) =>
    Object.assign(node.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });

  const norm = (r) => ({ x: r.x, y: r.y, w: r.w ?? r.width, h: r.h ?? r.height });

  /** Where a live box currently is, read back off the inline style `setBox` wrote. */
  const boxOfNode = (d) => {
    const [tx, ty] = (d.style.translate || '0px 0px').split(' ');
    return { x: parseFloat(tx) || 0, y: parseFloat(ty) || 0,
             w: parseFloat(d.style.width) || 0, h: parseFloat(d.style.height) || 0 };
  };

  /**
   * The box collapses back onto the centre of what it was pointing at instead of being deleted
   * out from under the pointer - the entrance run backwards and quicker.
   *
   * `instant` is for the clears nobody is watching, and for the one caller that is about to
   * repaint the very box it is clearing: a hover moving between words, a scroll re-derive, a
   * panel closed while the whole overlay is invisible for a screenshot.
   */
  function clearHighlight(instant) {
    const dying = [...el.hls.children];
    el.hls.textContent = '';
    el.tag.classList.remove('on');
    state.hlSource = null;
    if (instant || !dying.length) return;
    for (const d of dying) {
      // Out of the live pool first. `paintHighlight` reuses boxes by index, so one left there
      // on its way out would be picked up and animated back in as the next hover.
      el.ghosts.appendChild(d);
      const r = boxOfNode(d);
      d.className = `${d.className.replace(/\s*\b(move|open)\b/g, '')} gone`;
      d.getBoundingClientRect();
      setBox(d, { x: r.x + r.w / 2, y: r.y + r.h / 2, w: 0, h: 0 });
    }
    setTimeout(() => { for (const d of dying) d.remove(); }, EXIT_MS + 40);
  }

  /**
   * The boxes are fixed-position viewport coordinates, so any scroll or resize strands them
   * over whatever now happens to sit there. They are re-derived from the locator instead - the
   * anchor being written about and a pin being read back alike - and cleared if it is lost.
   */
  function repaintHighlight(instant) {
    const loc = state.hlSource;
    if (!loc) return;
    const rects = resolveRects(loc);
    if (rects?.length) paintHighlight(rects, loc.kind === 'selection' ? 'text' : 'element', instant);
    else clearHighlight();
  }

  const setBox = (node, r) =>
    Object.assign(node.style, {
      translate: `${r.x}px ${r.y}px`, width: `${r.w}px`, height: `${r.h}px`,
    });

  /**
   * One box per rect - a single box for an element, one per line box for text.
   *
   * Boxes are REUSED rather than rebuilt. Recreating them on every mousemove is what made the
   * outline jump: a brand new node has nothing to transition from. A node that is merely moved
   * animates, so the outline glides from one element to the next.
   *
   * `instant` skips the animation for repaints that are not a change of target - scrolling and
   * resizing, where the box must stay pinned to its element rather than lag behind it.
   */
  function paintHighlight(rects, kind, instant) {
    const list = (Array.isArray(rects) ? rects : [rects])
      .map(norm).filter((r) => r.w > 0 || r.h > 0).slice(0, 24);
    const cls = kind === 'text' ? 'hl text' : kind === 'word' ? 'hl text word' : 'hl';

    for (let i = 0; i < list.length; i++) {
      let d = el.hls.children[i];
      const fresh = !d;
      if (fresh) {
        d = document.createElement('div');
        el.hls.appendChild(d);
      }
      const r = list[i];
      if (fresh && !instant) {
        // Collapsed onto its own centre and invisible, flushed, then opened. Both axes, not
        // just width: growing at full height drew a tall thin sliver for the first frames,
        // which read as a line flashing up before the box arrived.
        d.className = cls;
        d.style.opacity = '0';
        setBox(d, { x: r.x + r.w / 2, y: r.y + r.h / 2, w: 0, h: 0 });
        d.getBoundingClientRect();
        d.className = `${cls} open`;
        d.style.opacity = '';
        setBox(d, r);
      } else {
        d.className = instant ? cls : `${cls} move`;
        setBox(d, r);
      }
    }
    while (el.hls.children.length > list.length) el.hls.lastElementChild.remove();
  }

  const moved = (d, e) => Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > DRAG_THRESHOLD;

  function onMove(e) {
    if (!state.picking) return;
    const d = state.drag;

    // Pointer on our own UI - the toolbar tab, a pin, the panel. Drop the hover rather than
    // leave the outline stranded on whatever the cursor last passed over; the tool is not
    // pointing at anything while you are reaching for its own controls. Comment mode itself
    // stays on: moving onto the tab is not a decision to stop commenting. Mid-drag this is
    // skipped, so a box dragged out over the tab keeps tracking.
    if (isOurs(e.target) && !d) return leaveTarget();

    // A text drag is the browser's own selection; stay out of its way entirely.
    if (d?.mode === 'text') { state.word = null; clearHighlight(); return; }

    if (d && (d.moved || moved(d, e))) {
      d.moved = true;
      cancelDwell();
      const r = {
        x: Math.min(d.x0, e.clientX), y: Math.min(d.y0, e.clientY),
        w: Math.abs(e.clientX - d.x0), h: Math.abs(e.clientY - d.y0),
      };
      place(el.band, r);
      el.band.classList.add('on');
      clearHighlight(true);
      d.candidates ??= regionCandidates();
      const n = elementsInRegion(r, d.candidates).length;
      el.tag.textContent = n ? `${n} element${n === 1 ? '' : 's'}` : 'region';
      Object.assign(el.tag.style, { left: `${r.x}px`, top: `${r.y > 22 ? r.y - 20 : r.y + r.h + 4}px` });
      el.tag.classList.add('on');
      return;
    }
    if (d) return;

    const next = resolveTarget(e.clientX, e.clientY);
    // Before the dwell, and on every move: which word the pointer is over changes with every
    // pixel, so waiting for the target to settle would leave the tint lagging behind the thing
    // it is meant to be pointing at.
    if (next.kind === 'text') paintWord(next.range, e.clientX);
    else if (state.word) { state.word = null; clearHighlight(true); }
    if (sameTarget(next, state.target)) { cancelDwell(); return; }

    // The first target after arming appears at once - waiting there would just look broken.
    // Every later change has to be held for DWELL_MS, so sweeping past things does not drag
    // the outline along with the pointer.
    if (!state.target) { commitTarget(next); return; }
    cancelDwell();
    state.dwell = setTimeout(() => { state.dwell = null; commitTarget(next); }, DWELL_MS);
  }

  /**
   * What the pointer is over, as an identity that can be compared between moves. Exactly one
   * hover state is ever shown: over text the I-beam is the whole affordance, so no box is
   * drawn - boxing text would read as the element outline it deliberately is not.
   */
  function resolveTarget(x, y) {
    const caret = textCaretAt(x, y);
    if (caret) return { kind: 'text', node: caret.startContainer, range: caret };
    const t = targetAt(x, y);
    return t ? { kind: 'element', node: t } : { kind: 'none', node: null };
  }

  const sameTarget = (a, b) => Boolean(a && b && a.kind === b.kind && a.node === b.node);

  function commitTarget(tg) {
    state.target = tg;
    root.classList.toggle('cc-pick-text', tg.kind === 'text');
    // Text hover is painted per move by paintWord, not here - clearing on the dwell would
    // wipe the tint a moment after the pointer arrived on the word.
    if (tg.kind === 'text') return;
    if (tg.kind !== 'element') return clearHighlight();
    // No label: the outline is the whole answer to "what is under the pointer", and a tag
    // riding along with it was one more thing moving on a page being looked at.
    paintHighlight(rectOf(tg.node.getBoundingClientRect()));
    // A locator like any other, so a scroll with the pointer held still carries the outline with
    // the element. Painted from nothing but coordinates, it stayed where the element had been.
    state.hlSource = { kind: 'element', _el: tg.node };
  }

  function onDown(e) {
    // A comment being read back inside comment mode gives way to the next pick: pressing on the
    // page closes it and carries on as if it had never been opened.
    if (state.viewing && state.keepMode && e.isTrusted && e.button === 0 && !isOurs(e.target)) closePopover();
    if (!state.picking || !e.isTrusted || isOurs(e.target) || e.button !== 0) return;
    // From here the browser's own selection, or the drag band, is the feedback.
    state.word = null;
    // Snap to whatever is actually under the pointer, so the click and the outline agree
    // even if the dwell had not elapsed yet.
    cancelDwell();
    const now = resolveTarget(e.clientX, e.clientY);
    if (!sameTarget(now, state.target)) commitTarget(now);
    // Alt forces a box even over text, so framing a paragraph stays reachable.
    const caret = e.altKey ? null : textCaretAt(e.clientX, e.clientY);
    state.drag = { x0: e.clientX, y0: e.clientY, moved: false, mode: caret ? 'text' : 'region' };
    if (caret) {
      // Let the browser run the selection. It is exact, it handles wrapping, shadow roots and
      // bidi text, and nothing we could script matches it.
      clearHighlight();
    } else {
      e.preventDefault(); // suppress native selection/dragging while boxing
    }
  }

  function onUp(e) {
    if (!state.picking || !e.isTrusted) return;
    const d = state.drag;
    state.drag = null;
    el.band.classList.remove('on');
    if (!d || isOurs(e.target)) return;

    if (d.mode === 'text') {
      const sel = selectionAnchor();
      if (sel) return openPopover(sel.anchor, locatorFor(sel.anchor, sel.range));
      // Nothing was selected - treat it as a plain click on the element.
    }

    if (d.mode === 'region' && d.moved) {
      const r = {
        x: Math.round(Math.min(d.x0, e.clientX)), y: Math.round(Math.min(d.y0, e.clientY)),
        w: Math.round(Math.abs(e.clientX - d.x0)), h: Math.round(Math.abs(e.clientY - d.y0)),
      };
      if (r.w < 5 || r.h < 5) return;
      // One more than we list, because "there are more" has to be judged before the cap:
      // a region holding exactly REGION_MAX_ELEMENTS reported as truncated otherwise.
      const all = elementsInRegion(r, d.candidates || regionCandidates(), REGION_MAX_ELEMENTS + 1);
      const found = all.slice(0, REGION_MAX_ELEMENTS);
      const under = targetAt(r.x + r.w / 2, r.y + r.h / 2);
      const anchor = {
        kind: 'region',
        rect: r,
        elements: found.map(brief),
        truncated: all.length > REGION_MAX_ELEMENTS || undefined,
        // Only worth reporting when nothing was captured inside the box (a PDF or canvas);
        // alongside a populated element list it is just a confusing duplicate.
        container: !found.length && under
          ? { selector: cssSelector(under), path: domPath(under) }
          : undefined,
      };
      return openPopover(anchor, locatorFor(anchor, found[0]));
    }

    const t = targetAt(e.clientX, e.clientY);
    if (!t) return;
    const anchor = describe(t);
    openPopover(anchor, locatorFor(anchor, t));
  }

  /** All the way out, in one call, so the two right-click handlers below cannot drift apart. */
  function leaveCommentMode() {
    cancelDwell();
    closePopover();
    setPicking(false);
  }

  /**
   * Right-click is the escape hatch: one gesture out of comment mode, wherever you are in it.
   * Inside our own popover the native menu is left alone, so copy and paste still work there.
   */
  function onContextMenu(e) {
    if (isOurs(e.target)) return;
    if (!state.picking && !panelOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    leaveCommentMode();
  }

  // While a comment is written the shield takes the pointer, so the right-click lands on it and
  // never on the page. A closed shadow root retargets that to the host, every `isOurs` predicate
  // answers "ours", and the handler above stands down - leaving the native menu open over a page
  // that is meant to be frozen. The shield stands in for the page, so it forwards the gesture.
  el.shield.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    leaveCommentMode();
  });

  // On `window`, not `document`: propagation runs window -> document -> element, so this is
  // the only place guaranteed to be ahead of every listener the page registered, including the
  // ones libraries put on `document` before we loaded. These sit on the same node as the
  // freeze below and are unaffected by it - stopPropagation stops the event moving to the next
  // node, never the other listeners already attached to this one.
  window.addEventListener('contextmenu', onContextMenu, true);
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('mousedown', onDown, true);
  window.addEventListener('mouseup', onUp, true);

  /**
   * In comment mode the page is frozen: it is a thing being looked at, not something being
   * used. Suppressing `click` alone was not enough - most component libraries open a menu, a
   * select or a dialog on `pointerdown`, so a page could change out from under the comment
   * before the click that was supposed to be swallowed ever happened. Hover cards, drag
   * handlers and keyboard shortcuts do the same. All of it stops here, in the capture phase.
   *
   * stopPropagation rather than preventDefault, because the browser behaviours that do NOT
   * change the page are exactly the ones still wanted: native text selection is the whole
   * mechanism behind a quoted anchor, and scrolling, find-in-page and browser shortcuts have
   * to keep working while you look for what to comment on. Only the handful of defaults that
   * really would change the page - following a link, a middle-click, a drag - are prevented.
   *
   * `scroll` and `wheel` are deliberately absent: scrolling is how you reach the thing you
   * want to point at, and blocking wheel propagation would freeze scroll containers that
   * implement their own scrolling.
   */
  const FREEZE = [
    'pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout',
    'pointerenter', 'pointerleave', 'pointercancel',
    'gotpointercapture', 'lostpointercapture',
    'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave',
    'click', 'dblclick', 'auxclick', 'contextmenu',
    'touchstart', 'touchmove', 'touchend', 'touchcancel',
    // `wheel` and `scroll` stay off this list on purpose - see docs/DESIGN.md. A container that
    // implements its own scrolling would be frozen solid by stopping them.
    'dragstart', 'dragover', 'dragenter', 'dragleave', 'dragend', 'drop',
    'keydown', 'keypress', 'keyup',
    'focusin', 'focusout',
  ];
  const FREEZE_DEFAULT = new Set(['click', 'dblclick', 'auxclick', 'dragstart', 'drop']);
  const KEYS = new Set(['keydown', 'keypress', 'keyup']);

  for (const type of FREEZE) {
    const isKey = KEYS.has(type);
    window.addEventListener(type, (e) => {
      // The cheap question first. These 36 listeners sit on every page for the life of the tab,
      // and pointermove/mouseover ask them hundreds of times a second on a page where the tool
      // has never been opened - `isOurs` walking ancestors for each one. A key is the only kind
      // of event with anything to do outside comment mode (the stop below), so nothing else has
      // to find out whose target it is until the page is frozen.
      if (!isKey && !inCommentMode()) return;
      if (isOurs(e.target)) {
        // Keys typed into the panel are the panel's. A keyboard event leaves the shadow root
        // retargeted to its host, which no page shortcut handler recognises as a text field, so
        // without this every letter of a comment also reached the page's shortcuts. Stopping it
        // here does not stop the character landing in the textarea - that is the default action.
        if (isKey) e.stopPropagation();
        return;
      }
      // Reading a comment back outside comment mode leaves the page live for it.
      if (!inCommentMode()) return;
      e.stopPropagation();
      if (FREEZE_DEFAULT.has(type)) e.preventDefault();
    }, true);
  }

  // ------------------------------------------------- text selection -> quote anchor
  /** The current selection as an anchor, with the live Range the highlight follows; or null. */
  function selectionAnchor() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    const range = sel.getRangeAt(0);
    if (isOurs(range.commonAncestorContainer?.parentElement)) return null;
    const r = range.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    const common = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    // Text held directly by <body> has no element worth naming; the quote itself is the anchor.
    const holder = common && !isPage(common) ? common : null;
    return {
      anchor: {
        kind: 'selection',
        selectedText: text.slice(0, 2000),
        selector: holder ? cssSelector(holder) : undefined,
        path: holder ? domPath(holder) : undefined,
        testid: holder?.getAttribute?.('data-testid') || undefined,
        html: holder ? holder.cloneNode(false).outerHTML : undefined,
        rect: rectOf(r),
      },
      range: range.cloneRange(),
    };
  }

  /**
   * How to find an anchor again: the record a pin keeps, built once when the anchor is picked.
   * `live` is the node, Range or first contained element in hand at that moment, cached so the
   * DOM is not searched while it is still there. The outline while the comment is written and
   * the pin after it is sent are both resolved from this through `resolveRects`, so there is
   * one answer to "where is it now" - and a region dragged inside a scrolling pane stays on its
   * content while the comment is being written, not only once it has been sent.
   */
  function locatorFor(anchor, live) {
    const r = anchor.rect;
    const loc = { kind: anchor.kind, selector: anchor.selector, w: Math.round(r.w), h: Math.round(r.h) };
    if (anchor.kind === 'selection') return Object.assign(loc, { quote: anchor.selectedText, _range: live });
    if (anchor.kind !== 'region') return Object.assign(loc, { _el: live });
    const first = anchor.elements?.[0];
    /**
     * A region is a rectangle on screen, not a node, so it is pinned to the nearest thing that
     * IS one: an element it contains, plus the offset from it. The box comes back the exact size
     * it was dragged and in the right place, however the page has moved since. Only over a canvas
     * or a PDF, with no DOM to point at at all, is the rectangle itself kept.
     */
    if (first?.selector) {
      return Object.assign(loc, {
        ref: { selector: first.selector, dx: Math.round(r.x - first.rect.x), dy: Math.round(r.y - first.rect.y) },
        _ref: live,
      });
    }
    return Object.assign(loc, { rect: { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: loc.w, h: loc.h } });
  }

  /** What the panel's header calls an anchor - and, once sent, its pin. */
  function labelFor(anchor) {
    if (anchor.kind === 'region') {
      const n = anchor.elements?.length || 0;
      return n ? `region · ${n} element${n === 1 ? '' : 's'}` : `region ${anchor.rect.w}×${anchor.rect.h}`;
    }
    if (anchor.kind === 'selection') return `selection · ${anchor.selectedText.length} chars`;
    return (anchor.testid ? `[data-testid=${anchor.testid}]` : anchor.selector) || anchor.path;
  }

  // ------------------------------------------------- popover
  function openPopover(anchor, loc) {
    setPicking(false, true);
    state.target = null;
    state.anchor = anchor;
    state.hlSource = loc;
    // Instant, always. Confirming an anchor is not the box appearing - it is already on screen
    // and already in the right place, whether as the hover outline, the drag band or the
    // browser's own selection. Replaying the entrance made a click look like a second event.
    repaintHighlight(true);

    el.what.textContent = labelFor(anchor);
    el.what.title = anchor.selector || '';

    if (anchor.kind === 'selection') {
      el.quoted.textContent = anchor.selectedText;
      el.quoted.classList.add('on');
    } else el.quoted.classList.remove('on');

    el.hint.textContent = [
      cfg.repo ? `\u2192 ${cfg.repo}` : '',
      anchor.kind === 'region' && anchor.elements?.length
        ? anchor.elements.slice(0, 3).map((x) => x.tag).join(', ') + (anchor.elements.length > 3 ? ' \u2026' : '')
        : '',
    ].filter(Boolean).join('  \u00b7  ');

    el.ta.value = '';
    setStatus('');
    // Every comment picks its own destination, so a panel always opens with the list closed.
    el.dest.classList.remove('on');
    refreshSlack();
    placePopover(anchor.rect);
    syncFab();
    el.ta.focus();
    preShot = shotAuto ? preCapture(anchor) : null;
  }

  /**
   * The screenshot is taken the moment an anchor is picked, not when the comment is sent.
   *
   * No screenshot API can leave an element out of the picture, so the overlay has to be out of the
   * way when the shutter goes - and taken at Send, that meant everything on the page blinked out
   * and back just as the comment went. Here the only moment the tool steps aside is the one where
   * the panel is about to appear anyway, so it reads as the panel arriving; Send then closes the
   * panel and nothing else moves. The page is frozen while a comment is written, so the frame from
   * the moment of pointing is the page the comment is about.
   *
   * What steps aside is everything but the outline: the panel and scrim (hidden until the frame is
   * taken, then given their entrance), the pins, the dock and the list. The outline stays, because
   * it is what the pointer is on - a blink there would be the most visible blink of all - and the
   * red ring drawn into the frame lands on top of it.
   *
   * Only with the extension: without it every capture is a share-this-tab prompt, which is asked
   * for at Send. If this frame does not come back - two picks inside Chrome's two-a-second limit,
   * the tab not showing - Send takes one the old way.
   */
  let preShot = null; // { anchor, promise } for the anchor being written about
  let asideHolds = 0; // overlapping picks each hold the overlay aside until their own frame is in

  function preCapture(anchor) {
    // Inside Chrome's limit the capture would wait, and the overlay would wait hidden with it - a
    // longer blink than the one being avoided. Send takes the frame instead.
    if (Date.now() - lastGrabAt < 550) return null;
    const promise = (async () => {
      asideHolds++;
      host.classList.add('cc-capturing');
      try {
        await settlePaint();
        const rect = anchorRectNow() || anchor.rect;
        const frame = await grabFrame();
        if (frame?.error) markShot(captureError = frame.error);
        else markShot(null);
        return { frame, rect };
      } finally {
        if (--asideHolds === 0) host.classList.remove('cc-capturing');
        if (composing() && state.anchor === anchor) {
          // The panel and scrim ran their entrances while hidden; run them again where they can be seen.
          el.pop.classList.add('enter');
          el.pop.getBoundingClientRect();
          el.pop.classList.remove('enter');
          el.scrim.classList.remove('on');
          el.scrim.getBoundingClientRect();
          placeScrim();
          el.ta.focus(); // hidden, it could not take focus when the panel opened
        }
      }
    })();
    return { anchor, promise };
  }

  const EDGE = 12; // the panel keeps this clear of the viewport edge

  /** A panel position pulled back inside the viewport. */
  const clampPop = (x, y, W = el.pop.offsetWidth, H = el.pop.offsetHeight) => [
    Math.min(Math.max(EDGE, x), Math.max(EDGE, innerWidth - W - EDGE)),
    Math.min(Math.max(EDGE, y), Math.max(EDGE, innerHeight - H - EDGE)),
  ];

  /**
   * The panel just changed height - the Slack picker opened or closed. It keeps the placement it
   * was given and is only pulled back inside the viewport: re-running the placement would let a
   * panel below its anchor flip above it because a search box appeared, which reads as the page
   * jumping while a comment is being written.
   */
  function nudgePop() {
    if (!panelOpen()) return;
    const [x, y] = clampPop(parseFloat(el.pop.style.left) || 0, parseFloat(el.pop.style.top) || 0);
    el.pop.style.left = `${x}px`;
    el.pop.style.top = `${y}px`;
    const a = anchorRectNow();
    if (a) state.popAt = { dx: x - a.x, dy: y - a.y };
  }

  /**
   * Where the anchor is right now, taken from the boxes that are drawn on it. Every kind of
   * anchor - element, quote, region, a pin resolved from the DOM - has already been reduced to
   * those boxes by the time anyone asks, so there is one answer here rather than four.
   */
  function anchorRectNow() {
    const boxes = [...el.hls.children].map(boxOfNode).filter((r) => r.w > 0 || r.h > 0);
    return boxes.length ? unionRect(boxes) : null;
  }

  /**
   * The panel is fixed-position, so left to itself it stays where it is on screen while the
   * thing it is about slides away underneath - which is how a comment ends up parked halfway
   * down the page from the element it belongs to. It travels with the anchor instead, keeping
   * the offset that was chosen when it opened; the placement itself is not re-scored, since a
   * panel that flips from below the anchor to above it mid-scroll is worse than one that is
   * merely a little lower than it would have picked.
   */
  function movePopover() {
    placeScrim(); // the cutout moves with the same outline the panel does
    if (!state.popAt || !panelOpen()) return;
    const a = anchorRectNow();
    if (!a) return;
    const [x, y] = clampPop(a.x + state.popAt.dx, a.y + state.popAt.dy);
    el.pop.style.left = `${x}px`;
    el.pop.style.top = `${y}px`;
  }

  /** The extent of a multi-rect anchor: a selection is one quote, not four line boxes. */
  const unionRect = (list) => {
    const x = Math.min(...list.map((r) => r.x));
    const y = Math.min(...list.map((r) => r.y));
    return {
      x, y,
      w: Math.max(...list.map((r) => r.x + r.w)) - x,
      h: Math.max(...list.map((r) => r.y + r.h)) - y,
    };
  };

  const overlap = (a, b) => {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
  };

  let leaveTimer = null;

  /**
   * The panel sits next to what it is about, and the one thing it must not do is cover it -
   * a comment written about something you can no longer see is written half blind.
   *
   * Four placements are tried in order and the first that lands clear of the anchor wins:
   * below, above, right, left. Order is the tie-break, not the rule; each is clamped into the
   * viewport first and then scored, because a placement that fits only after being pushed
   * back over the anchor has not really fitted. Sitting on the corner button costs something
   * too, but far less than hiding the anchor - it is untidy, not blinding. When the anchor is
   * big enough that nothing can clear it, the least-covering placement wins.
   */
  function placePopover(rect) {
    // A close that is still animating is cancelled outright rather than allowed to finish and
    // pull the panel out from under the one that has just opened.
    clearTimeout(leaveTimer);
    leaveTimer = null;
    const fresh = !panelOpen();
    el.pop.classList.remove('leave');
    // Show first, then measure: the height depends on whether a quote block is present and on
    // how the textarea has been resized, so a hardcoded guess drifts off-screen.
    el.pop.style.visibility = 'hidden';
    el.pop.classList.add('on');
    const W = el.pop.offsetWidth || 400;
    const H = el.pop.offsetHeight || 240;
    const G = 12; // keep clear of the anchor
    const a = rect || { x: innerWidth / 2, y: innerHeight / 2, w: 0, h: 0 };
    // The tab and the list button above it.
    const dock = { x: innerWidth - 64, y: innerHeight - 132, w: 64, h: 132 };
    const side = state.listOpen ? rectOf(el.side.getBoundingClientRect()) : null;

    let best = null;
    for (const c of [
      { x: a.x, y: a.y + a.h + G },       // below, left edges aligned
      { x: a.x, y: a.y - H - G },         // above
      { x: a.x + a.w + G, y: a.y },       // to the right
      { x: a.x - W - G, y: a.y },         // to the left
    ]) {
      const [x, y] = clampPop(c.x, c.y, W, H);
      const box = { x, y, w: W, h: H };
      // The open list is nearly as much in the way as the anchor: it is what was being read.
      const cost = overlap(box, a) * 4 + (side ? overlap(box, side) * 2 : 0) + overlap(box, dock);
      if (!best || cost < best.cost) best = { x: box.x, y: box.y, cost };
      if (cost === 0) break;
    }
    Object.assign(el.pop.style, { left: `${best.x}px`, top: `${best.y}px`, visibility: '' });
    // Remembered as an offset from the anchor rather than as a position, so the panel can be
    // carried along by whatever the anchor does next. Measured against the live highlight, not
    // against `rect`, so the two agree to the pixel and the first scroll does not jump.
    const live = anchorRectNow();
    state.popAt = live ? { dx: best.x - live.x, dy: best.y - live.y } : null;
    // One frame low and invisible with the transition off; removing the class is the animation.
    if (fresh) {
      el.pop.classList.add('enter');
      el.pop.getBoundingClientRect();
      el.pop.classList.remove('enter');
    }
  }

  /**
   * `resume` sends the user back to picking rather than switching the tool off. Cancelling one
   * comment means "not this one", not "I am done" - dropping out of the mode would make them
   * re-arm it for every mistaken pick.
   */
  function closePopover({ resume = false, instant = false } = {}) {
    disarmDelete();
    el.dest.classList.remove('on');
    const wasViewing = Boolean(state.viewing);
    const backToPicking = wasViewing ? state.keepMode : resume;
    state.viewing = null;
    state.keepMode = false;
    preShot = null; // a frame for a comment not sent is not kept
    if (el.pop.classList.contains('on')) {
      clearTimeout(leaveTimer);
      if (instant) {
        el.pop.classList.remove('on', 'viewing', 'enter', 'leave');
        leaveTimer = null;
      } else {
        // Still displayed while it goes, then undisplayed. Everything that asks whether a
        // comment is being written already discounts a panel carrying "leave", so the tool
        // reads as off from the first frame of the animation rather than a beat after the last.
        el.pop.classList.remove('enter');
        el.pop.classList.add('leave');
        leaveTimer = setTimeout(() => {
          el.pop.classList.remove('on', 'viewing', 'leave');
          leaveTimer = null;
        }, EXIT_MS + 30);
      }
    }
    if (wasViewing) renderPins();
    clearHighlight(instant);
    if (instant) {
      // Gone before the overlay comes back from the screenshot, not fading out after it does.
      el.scrim.style.transition = 'none';
      el.scrim.classList.remove('on');
      el.scrim.getBoundingClientRect();
      el.scrim.style.transition = '';
    }
    state.anchor = null;
    state.popAt = null;
    setStatus('');
    // A read-back returns to whatever mode it was opened in - it never arms picking on its own,
    // and one opened in comment mode does not end it.
    if (backToPicking) {
      try { window.getSelection()?.removeAllRanges(); } catch {}
      setPicking(true);
    } else syncFab();
  }

  /**
   * A sent comment, read back from the pin. Same panel, same edge; the compose controls drop
   * out and the anchor it was left on is outlined again, so "what was this about" is answered
   * without going back to the session. `near` places it when the anchor is lost: beside the list
   * row it was opened from.
   */
  function openPinView(p, near) {
    // Read before anything below changes it: moving from one comment to the next keeps the mode.
    const keep = inCommentMode();
    setPicking(false);
    state.target = null;
    state.anchor = null;
    state.viewing = p;
    state.keepMode = keep;
    el.pop.classList.add('viewing');
    el.what.textContent = `#${p.n}` + (p.label ? ` \u00b7 ${p.label}` : '');
    el.what.title = p.label || '';
    el.quoted.classList.remove('on');
    el.said.textContent = p.comment;
    setStatus('');
    disarmDelete();

    // What was pointed at is drawn again, in the same language as when it was picked: a box
    // for an element or a dragged region, a tint for quoted text. Reading the comment back
    // without it would leave "which one was this?" unanswered.
    const rects = resolveRects(p);
    // An anchor that cannot be found is said so plainly, rather than opening a panel with no
    // outline and letting it read as a bug.
    el.hint.textContent = [
      p.ts ? new Date(p.ts).toLocaleString() : '',
      rects?.length ? '' : 'anchor no longer on this page',
    ].filter(Boolean).join(' \u00b7 ');
    // Placed against the whole quote, not its first line: a selection is stored as its
    // individual line boxes, and clearing rects[0] alone dropped the panel onto the rest.
    const rect = rects?.length ? unionRect(rects) : null;
    if (rects?.length) {
      state.hlSource = p; // a pin is its own locator
      // Unlike confirming an anchor, this box is not already on screen - it is appearing, so it
      // gets the entrance rather than being switched on.
      repaintHighlight(false);
    }
    placePopover(rect || near);
    renderPins();
    syncFab();
  }

  /**
   * The overlay steps out of its own screenshot. It used to blink out and back, which read as
   * the page glitching; a fade of the same length reads as the tool standing aside. The fade
   * is the manners - the visibility flip after it is the guarantee, since a tab that never
   * paints (there are such tabs) would otherwise still be at full opacity when the shutter goes.
   */
  async function veil(hide) {
    host.style.transition = `opacity ${VEIL_MS}ms linear`;
    if (hide) {
      host.style.opacity = '0';
      await new Promise((r) => setTimeout(r, VEIL_MS));
      host.style.visibility = 'hidden';
    } else {
      host.style.visibility = '';
      host.style.opacity = '';
      await new Promise((r) => setTimeout(r, VEIL_MS));
    }
  }

  /**
   * One comment, two possible destinations - and they are alternatives, not a fan-out. Send
   * files it in the session; Slack posts it to a person or a channel as the user, and tells the
   * session nothing. Everything up to the moment of sending is shared, the screenshot above all:
   * a comment is the same comment wherever it is going.
   */
  async function submit({ slack = false, dest = null } = {}) {
    const comment = el.ta.value.trim();
    // Cmd+Enter reaches here from anything of ours that has focus - a list row, the tab - and the
    // textarea still holds the last comment sent. Only a comment being written is sent.
    //
    // Slack is the exception to needing one: a screenshot of the thing, with the page and the
    // element named under it, is often all there is to show someone.
    if (state.busy || !composing()) return;
    if (!comment && !slack) return;
    if (slack && (!cfg.slack || !dest)) return;
    state.busy = true;
    el.send.disabled = true;
    el.slack.disabled = true;
    el.close.disabled = true;
    (slack ? el.slack : el.send).classList.add('busy');
    setStatus('');
    const anchor = state.anchor;
    const loc = state.hlSource;
    const ext = await hasExtension();
    // The frame taken when this anchor was picked (see `preCapture`). With it, nothing on the page
    // has to step aside now: the panel closes and a pin appears, and that is all that moves.
    const pre = preShot?.anchor === anchor ? await preShot.promise : null;
    const early = Boolean(pre?.frame?.dataUrl);
    // Without it, a frame is taken now, the overlay stepping out of it. Only if something is
    // actually going to be captured - with no extension and no screenshot asked for there is
    // nothing to hide from, and hiding anyway is a flicker that buys nothing.
    const capturing = !early && (ext || state.wantShot);
    // The panel stays open and keeps the anchor outlined until the comment is actually in the
    // session. Closing on click and reporting afterwards meant a failure had nowhere to land
    // but a toast, with the typed comment already gone.
    try {
      if (capturing) { await veil(true); await settlePaint(); }
      // A wedged extension or a stalled share-tab prompt must never cost the comment.
      const shot = early ? await encodeFrame(pre.frame, pre.rect) : capturing ? await Promise.race([
        // Where the outline is now, not where the anchor was when picked - the page may have
        // scrolled while the comment was written.
        screenshot(anchorRectNow() || anchor.rect),
        new Promise((r) => setTimeout(() => r(null), 10000)),
      ]) : null;
      const body = {
        previewId: cfg.previewId,
        comment,
        // The highest marker still on THIS page - numbering is per page, as the markers are.
        // The daemon's counter and these markers can drift apart - a cleared scratch dir, a
        // restarted daemon, an id carried over from an older format - and the page is the side
        // holding the evidence.
        after: pins.reduce((m, p) => (p.page === pageKey() ? Math.max(m, p.n || 0) : m), 0),
        page: {
          url: location.href, title: document.title,
          viewport: [innerWidth, innerHeight], dpr: window.devicePixelRatio || 1,
          scroll: [Math.round(scrollX), Math.round(scrollY)],
        },
        anchor,
        console: consoleErrors.slice(-5),
        screenshot: shot,
        // Says why a screenshot is missing, so a broken capture path explains itself in the
        // notification instead of needing a round trip with the user.
        capture: shot ? undefined : { extension: ext, error: captureError || undefined },
      };
      /**
       * Injected by the extension, the comment leaves from the service worker. A page on an
       * https origin reaching http://127.0.0.1 is a local-network request, which Chrome gates
       * behind a permission from version 142, and the bridge accepts an automatically bound
       * origin's comments only from the extension anyway.
       *
       * In the page world - a page the bridge serves, or the bookmarklet - it is posted directly.
       * There is no falling back from one to the other: a worker that timed out may still have
       * delivered, and posting again would send the comment twice.
       */
      let j;
      if (slack) {
        // Two file uploads and a post, over someone's office wi-fi: the panel waits for as long
        // as that takes rather than reporting a failure the message then contradicts.
        j = await askExtension('slackShare', { ...body, dest }, 60000);
        // Same as the comment path below: the code is the part of the worker's answer that is
        // not prose, and an unreachable bridge has to be recognisable here too.
        if (j.error) throw Object.assign(new Error(j.error), { code: j.code, status: j.status });
        // Nothing is pinned and nothing closes: the comment is in Slack, the session has not
        // been told, and what was typed is still here to send on with the next click.
        if (capturing) await veil(false);
        setStatus(`Sent to ${j.label || dest.label}`, true);
        return;
      }
      if (isolated) {
        j = await askExtension('comment', body, 20000);
        // The worker answers a failure rather than throwing one, and `code` is the part of that
        // answer which is not prose. Carried onto the error so the catch can read it instead of
        // matching on a sentence the worker is free to reword.
        if (j.error) throw Object.assign(new Error(j.error), { code: j.code, status: j.status });
      } else {
        const res = await fetch(`${cfg.origin}/comment`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `bridge ${res.status}`);
      }
      addPin(j.n, comment, anchor, loc);
      // Sending is not "I am done" - a review pass is several comments in a row.
      //
      // With a frame taken at Send, closed while the overlay is still invisible, so it is not put
      // back on screen for one frame purely to be taken away again: that read as a flash followed
      // by a disappearance.
      closePopover({ resume: true, instant: capturing });
      if (capturing) await veil(false);
    } catch (e) {
      if (capturing) await veil(false);
      // One condition, two paths. Where the worker sent the comment it says so in a code, having
      // done the fetch on our behalf; where this page sent it itself - a page the bridge serves,
      // or the bookmarklet - the fetch is ours and the browser reports an unreachable bridge and
      // a refused cross-origin request with the same opaque "Failed to fetch". Neither is
      // something to read a stack trace about - say the one thing that fixes it instead.
      const offline = e.code === 'bridge_unreachable' || e.code === 'bridge_timeout'
        || /failed to fetch|networkerror|load failed|fetch failed/i.test(e.message || '');
      // Named for the button that was pressed: a Slack share goes through the bridge too, and
      // "then Send" would point at the wrong one.
      setStatus(offline
        ? `The bridge is not answering - run /preview again in the session, then ${slack ? 'Slack' : 'Send'}.`
        : `Not sent - ${e.message}`);
    } finally {
      host.style.visibility = '';
      host.style.opacity = '';
      state.busy = false;
      el.send.disabled = false;
      el.slack.disabled = false;
      el.close.disabled = false;
      el.send.classList.remove('busy');
      el.slack.classList.remove('busy');
    }
  }

  /**
   * Two-step, because there is no undo. The comment itself is already in the session - this
   * removes the marker from the page, which is the only copy of it that lives here.
   */
  let disarmTimer = null;
  function disarmDelete() {
    clearTimeout(disarmTimer);
    disarmTimer = null;
    if (el.del.classList.contains('arm')) setStatus('');
    el.del.classList.remove('arm');
    el.del.title = 'Delete this comment';
  }

  el.del.addEventListener('click', (e) => {
    const p = state.viewing;
    if (!p || !e.isTrusted) return;
    if (!el.del.classList.contains('arm')) {
      el.del.classList.add('arm');
      el.del.title = 'Click again to delete';
      setStatus('Click again to remove this marker from the page.');
      disarmTimer = setTimeout(disarmDelete, 3000);
      return;
    }
    pins = pins.filter((x) => x !== p);
    savePins();
    closePopover();
    renderPins();
    watchDom(); // the last pin takes the DOM observer with it
  });

  // Only a real click sends. With the panel in a closed shadow root a page script cannot reach
  // these buttons, and this makes sure a synthesised event cannot stand in for the user either.
  el.send.addEventListener('click', (e) => { if (e.isTrusted) submit(); });
  el.close.addEventListener('click', (e) => { if (e.isTrusted) closePopover({ resume: true }); });

  /**
   * Where in Slack a comment goes - asked every time, answered in one gesture.
   *
   * The button opens the list and choosing from it posts; there is no remembered destination and
   * no second click to confirm. Posting happens under someone's own name, so which room it is
   * going to has to be a decision made at the moment of sending rather than a setting carried
   * over from a comment several minutes ago. What makes that cheap is the ordering: the bridge
   * puts the places last used at the top, so the usual one is the first row.
   *
   * The list names channels and the people they talk to, which is why it comes through the
   * worker and is never handed to the page.
   */
  let destRows = [];
  let destTimer = null;
  let destSeq = 0;
  let destAt = -1; // the row the arrow keys are on

  /**
   * Slack can be connected - or disconnected - from the toolbar menu while this tab sits open,
   * and the panel is where that has to show without a reload. Asked when a panel opens, which is
   * the only moment it matters; the worker caches the answer, so this costs nothing per comment.
   */
  async function refreshSlack() {
    if (!isolated) return;
    const s = await askExtension('slackStatus', {}, 6000);
    if (!s || s.error) return;
    cfg.slack = s.connected ? s : null;
    el.slack.hidden = !cfg.slack;
    if (!cfg.slack && el.dest.classList.contains('on')) showDest(false);
    el.slack.title = cfg.slack?.user
      ? `Post this to Slack as ${cfg.slack.user}`
      : 'Post this to Slack';
  }

  /** Which half of the list a row is in, and the character the search box filters on. */
  const sigilFor = (kind) => (kind === 'user' || kind === 'im' || kind === 'mpim' ? '@' : '#');

  function renderDest(rows, note) {
    destRows = rows || [];
    destAt = destRows.length ? 0 : -1;
    el.dlist.textContent = '';
    if (note) {
      const d = document.createElement('div');
      d.className = 'dnote';
      d.textContent = note;
      el.dlist.appendChild(d);
      return;
    }
    for (const [i, r] of destRows.entries()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `drow${i === destAt ? ' sel' : ''}`;
      const sig = document.createElement('span');
      sig.className = 'dsig';
      sig.textContent = sigilFor(r.kind);
      const name = document.createElement('span');
      name.className = 'dname';
      // The label carries its own sigil for the bridge's own matching; it is drawn separately.
      name.textContent = r.label.replace(/^[#@]/, '');
      b.append(sig, name);
      b.addEventListener('click', (e) => { if (e.isTrusted) chooseDest(r); });
      el.dlist.appendChild(b);
    }
  }

  /** Arrow keys move a visible selection, because Enter on it now posts. */
  function moveDest(by) {
    if (!destRows.length) return;
    destAt = (destAt + by + destRows.length) % destRows.length;
    const rows = [...el.dlist.querySelectorAll('.drow')];
    rows.forEach((r, i) => r.classList.toggle('sel', i === destAt));
    rows[destAt]?.scrollIntoView({ block: 'nearest' });
  }

  async function loadDest(q) {
    const mine = ++destSeq;
    const j = await askExtension('slackDestinations', { q }, 15000);
    // A slower answer to an older query must not overwrite the one being read.
    if (mine !== destSeq || !el.dest.classList.contains('on')) return;
    if (j.error) return renderDest(null, j.error);
    if (!j.rows?.length) return renderDest(null, q ? 'nothing matches' : 'no channels found');
    renderDest(j.rows);
  }

  function showDest(on) {
    el.dest.classList.toggle('on', on);
    nudgePop();
    if (!on) return el.ta.focus();
    el.destq.value = '';
    renderDest(null, 'Loading…');
    loadDest('');
    el.destq.focus();
  }

  /** Choosing is sending. */
  function chooseDest(r) {
    showDest(false);
    submit({ slack: true, dest: { id: r.id, kind: r.kind, label: r.label } });
  }

  el.slack.addEventListener('click', (e) => {
    if (!e.isTrusted || state.busy) return;
    showDest(!el.dest.classList.contains('on'));
  });

  el.destq.addEventListener('input', () => {
    clearTimeout(destTimer);
    destTimer = setTimeout(() => loadDest(el.destq.value.trim()), 160);
  });

  el.destq.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      return moveDest(e.key === 'ArrowDown' ? 1 : -1);
    }
    // Enter takes the selected row rather than clicking it: a synthesised click is untrusted,
    // and every control here refuses those.
    if (e.key === 'Enter' && destRows[destAt]) { e.preventDefault(); chooseDest(destRows[destAt]); }
  });

  /**
   * Free placement, for when the automatic one is wrong about what matters on the page - it
   * knows to keep off the anchor, but not that the thing you also need to see is two rows
   * below it.
   *
   * The drag is not recorded anywhere. It moves this panel while it is open; the next one is
   * placed by the same rules as ever. What it does change is the offset the panel travels by,
   * so from wherever it is dropped it goes on following the anchor - the rule is that the
   * panel stays with what it is about, and being dragged is not an exemption from it.
   */
  let popDrag = null;

  el.grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isTrusted) return;
    e.preventDefault();
    popDrag = {
      id: e.pointerId, x: e.clientX, y: e.clientY,
      left: parseFloat(el.pop.style.left) || 0, top: parseFloat(el.pop.style.top) || 0,
    };
    try { el.grip.setPointerCapture(e.pointerId); } catch {}
    el.pop.classList.add('dragging');
  });

  el.grip.addEventListener('pointermove', (e) => {
    if (!popDrag || e.pointerId !== popDrag.id) return;
    e.preventDefault();
    const [x, y] = clampPop(popDrag.left + e.clientX - popDrag.x, popDrag.top + e.clientY - popDrag.y);
    el.pop.style.left = `${x}px`;
    el.pop.style.top = `${y}px`;
  });

  const endPopDrag = (e) => {
    if (!popDrag || (e && e.pointerId !== popDrag.id)) return;
    popDrag = null;
    el.pop.classList.remove('dragging');
    const a = anchorRectNow();
    if (a) {
      state.popAt = { dx: (parseFloat(el.pop.style.left) || 0) - a.x,
                      dy: (parseFloat(el.pop.style.top) || 0) - a.y };
    }
  };
  el.grip.addEventListener('pointerup', endPopDrag);
  el.grip.addEventListener('pointercancel', endPopDrag);
  // A handle is not a button: a click that happened to start on it must not reach anything else.
  el.grip.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
  // The capture hides the whole overlay; make sure a failure mid-flight cannot leave it hidden.
  addEventListener('pagehide', () => { host.style.visibility = ''; host.style.opacity = ''; host.classList.remove('cc-capturing'); });

  /**
   * Entering pick mode with text already selected anchors that selection straight away.
   * The alternative - a bubble that appears on every selection - fires when the user is
   * merely copying text, so commenting stays behind the same single affordance as everything
   * else: turn the tool on, and only then does it want anything from you.
   */
  function togglePick() {
    if (state.picking) return setPicking(false);
    // Reading a comment back inside comment mode is still comment mode, and this turns it off.
    if (state.viewing && state.keepMode) { state.keepMode = false; return closePopover(); }
    const sel = selectionAnchor();
    if (sel) return openPopover(sel.anchor, locatorFor(sel.anchor, sel.range));
    setPicking(true);
  }

  el.fab.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    // The tab always leaves comment mode from a panel - a read-back included.
    if (panelOpen()) { state.keepMode = false; return closePopover(); }
    togglePick();
  });

  /**
   * `c` arms the tool only on local pages. The overlay reaches every site the browser opens, and
   * on a deployed app a bare letter is somebody's shortcut already - Gmail's compose, a tracker's
   * "create issue". There, the tab on the right edge is the way in.
   */
  const typingIn = (node) => node?.nodeType === 1
    && (/^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName) || node.isContentEditable
      // A custom element: if its shadow root is closed, the field inside it cannot be seen from
      // here at all, so a key aimed at it is given the benefit of the doubt.
      || node.tagName.includes('-'));

  // Capture phase on the window, where the page cannot get ahead of it. The freeze registered
  // above runs first on this same node, but stopPropagation never stops listeners on the node
  // it is called on - only the event's journey past it.
  window.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && isOurs(e.target)) {
      e.preventDefault();
      // Shift opens the Slack list, which is where that half of the panel starts: choosing a
      // row there is what posts.
      if (e.shiftKey) {
        if (cfg.slack && !state.busy) showDest(true);
        return;
      }
      submit();
      return;
    }
    if (e.key === 'Escape') {
      // The list is a step inside the panel, so it is what Escape takes back first - closing
      // the whole panel would throw away the comment because a channel search was open.
      if (el.dest.classList.contains('on')) { e.preventDefault(); showDest(false); return; }
      if (panelOpen()) { e.preventDefault(); closePopover({ resume: true }); return; }
      if (state.picking) setPicking(false);
      return;
    }
    if (e.key !== 'c' || !SHORTCUT || switchedOff || e.metaKey || e.ctrlKey || e.altKey || isOurs(e.target)) return;
    // The real target, not the retargeted one: an input inside a web component's shadow root
    // reaches the window as its host element, which does not look like a text field at all.
    if (typingIn(e.composedPath()[0])) return;
    // Swallow it here as well: on the keystroke that turns comment mode ON the freeze has
    // not seen it yet, and on the one that turns it OFF the freeze no longer applies.
    e.stopPropagation();
    e.preventDefault();
    togglePick();
  }, true);

  // ------------------------------------------------- pins
  /**
   * A pin is anchored to the DOM, not to the page.
   *
   * Storing screen coordinates and adding the window's scroll back on only ever worked for
   * pages that scroll as one document. Most apps scroll an inner container instead: the window
   * never moves, so every pin and every read-back highlight sat still while the content slid
   * out from under it. Nothing is positioned from stored coordinates any more. A pin remembers
   * how to FIND its anchor - a selector, and for a quote the text itself - and every repaint
   * asks the DOM where that is now. `getBoundingClientRect` is already viewport-relative and
   * already correct inside a scroll container, so there is no scroll arithmetic left to get
   * wrong.
   *
   * When the anchor cannot be found - the element is gone, the text has changed - the pin is
   * simply not drawn. An anchor pointing confidently at the wrong thing is worse than one that
   * admits it is lost. The comment is still counted and still in the list, marked as lost: it was
   * left here, it just cannot be pointed at right now.
   */
  function addPin(n, comment, anchor, loc) {
    // The locator the outline was already following, so the pin starts with its node in hand.
    const pin = { ...loc, n, comment, label: labelFor(anchor), ts: Date.now(), page: pageKey() };
    pins.push(pin);
    state.fresh = pin; // so this one, and only this one, gets an entrance
    savePins();
    renderPins();
    watchDom();
  }

  const PINS_KEPT = 100;

  /** Fields starting with `_` are runtime only - cached nodes, ranges, the pin's button. */
  function savePins() {
    if (pins.length > PINS_KEPT) pins = pins.slice(-PINS_KEPT);
    const save = pins.map((p) => Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('_'))));
    try { localStorage.setItem(PIN_KEY, JSON.stringify(save)); } catch {}
  }

  const loadPins = () => {
    try { return JSON.parse(localStorage.getItem(PIN_KEY) || '[]'); } catch { return []; }
  };
  let pins = loadPins();

  /** The quoted text, found again inside the element that held it, across node boundaries. */
  function findQuote(container, needle) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let all = '';
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      nodes.push({ node: t, at: all.length });
      all += t.textContent || '';
    }
    const start = all.indexOf(needle);
    if (start === -1) return null;
    const end = start + needle.length;
    const nodeAt = (i) => {
      for (let k = nodes.length - 1; k >= 0; k--) if (nodes[k].at <= i) return nodes[k];
      return null;
    };
    const a = nodeAt(start);
    const b = nodeAt(end - 1);
    if (!a || !b) return null;
    const range = document.createRange();
    try {
      range.setStart(a.node, start - a.at);
      range.setEnd(b.node, end - b.at);
    } catch { return null; }
    return range;
  }

  const liveEl = (sel) => {
    if (!sel) return null;
    let node = null;
    try { node = document.querySelector(sel); } catch { return null; }
    // A pin saved before <body> stopped being an anchor would otherwise come back as a box round the page.
    return node?.isConnected && !isPage(node) ? node : null;
  };

  /** Same lookup, remembered on the pin - this runs once per pin per scroll event. */
  const cachedEl = (p, key, sel) => {
    if (p[key]?.isConnected) return p[key];
    p[key] = liveEl(sel);
    return p[key];
  };

  /**
   * Everything a pin resolved, let go of. A route change under an SPA leaves every pin of the
   * route before it holding a detached node - and through that node its whole detached subtree -
   * for as long as the tab lives, since `cachedEl`'s isConnected check only ever runs for pins of
   * the page being drawn. Nothing is lost by dropping them: the nodes come back from the selector,
   * the range from the quote, the button and the row are rebuilt on sight. Those two are left
   * where they are, for the sweeps in `renderPins` to take out with every other undrawn one.
   */
  function forget(p) {
    if (!p._el && !p._ref && !p._holder && !p._range && !p._button && !p._row && !p._miss) return;
    p._el = p._ref = p._holder = p._range = p._button = p._row = null;
    p._miss = false;
  }

  /**
   * Where a locator's anchor is right now, in viewport coordinates, or null if it is gone.
   * The resolved node and range are cached on it: this runs on every repaint, and walking the
   * text of a container per frame is not something to do twice.
   */
  function resolveRects(p) {
    const boxes = (list) => list.filter((r) => r.w > 0 || r.h > 0);

    if (p.kind === 'selection') {
      if (!p._miss && (!p._range || !p._range.startContainer?.isConnected)) {
        // No holder means the quote sat directly in <body>: look for it across the page.
        const within = p.selector ? cachedEl(p, '_holder', p.selector) : document.body;
        p._range = (within && p.quote && findQuote(within, p.quote)) || null;
        // A quote that is not there is not there until the DOM changes, and `findQuote` walks
        // every text node of its container - of the whole body, for a quote with no holder. One
        // lost quote used to buy that walk on every scroll frame to find the same nothing. The
        // mark is cleared on the mutation path only, which is the one thing that can change the
        // answer; the holder fallback below still runs, so what is drawn is unchanged.
        p._miss = !p._range;
      }
      if (p._range) {
        const list = boxes([...p._range.getClientRects()].map(rectOf));
        if (list.length) return list;
      }
      // The quote has moved or changed; the element that held it is still an honest answer.
      const holder = cachedEl(p, '_holder', p.selector);
      return holder ? boxes([rectOf(holder.getBoundingClientRect())]) : null;
    }

    if (p.kind === 'region') {
      if (p.ref) {
        const node = cachedEl(p, '_ref', p.ref.selector);
        if (!node) return null;
        const b = node.getBoundingClientRect();
        return [{ x: Math.round(b.x + p.ref.dx), y: Math.round(b.y + p.ref.dy), w: p.w, h: p.h }];
      }
      // No DOM under it at all - a canvas or a PDF - so the rectangle itself is the anchor.
      if (p.rect) return [{ x: p.rect.x - scrollX, y: p.rect.y - scrollY, w: p.rect.w, h: p.rect.h }];
      return null;
    }

    const node = cachedEl(p, '_el', p.selector);
    return node ? boxes([rectOf(node.getBoundingClientRect())]) : null;
  }

  const PIN_SIZE = 24;
  const PIN_GAP = 7;

  /**
   * Beside the anchor, never on it. The marker used to be centred on the top-left corner, which
   * put a quarter of it inside the box - directly over the first word of whatever was being
   * commented on, which is the one thing the reader needs to see. So it is placed outside the
   * ring instead: left of the box, else above it, else below it. The one placement deliberately
   * not tried is to the right, which for a full-width element parks the marker a screen away
   * from what it belongs to.
   */
  function pinSpot(r) {
    const x = Math.round(r.x);
    const y = Math.round(r.y);
    const left = x - PIN_SIZE - PIN_GAP;
    if (left >= 2) return { x: left, y: y - 2 };
    const above = y - PIN_SIZE - PIN_GAP;
    if (above >= 2) return { x: Math.max(2, x - 2), y: above };
    const below = Math.round(r.y + r.h) + PIN_GAP;
    if (below + PIN_SIZE <= innerHeight - 2) return { x: Math.max(2, x - 2), y: below };
    // Nowhere clear to put it: back to the corner it came from. Overlapping a little is better
    // than a marker sitting halfway across the screen from the thing it belongs to.
    return { x: Math.max(2, x - 2), y: Math.max(2, y - 2) };
  }

  /** Whether the last render had anything on this page. Starts true, so the first one always runs. */
  let anyShown = true;

  /**
   * Each pin keeps its button for as long as it is drawn, and this only moves it. Rebuilding
   * every button on every scroll threw away a hovered pin's hover under the pointer and
   * restarted its transition, many times a second.
   */
  function renderPins() {
    const here = pageKey();
    // Nearly every page, nearly always, has nothing of ours on it - and this runs once a frame for
    // as long as anything on the page is scrolling. With nothing shown last time and nothing to
    // show now there is nothing to clear either, so stop before the sweeps, the counting and the
    // three titles. Whether there is anything here is counted live every time rather than
    // remembered: `pins` is the whole origin's list and `pageKey()` moves under an SPA with no
    // event we hear, so a cached answer would be wrong on the route it matters on - and a walk of
    // at most 100 entries is the cheap half of this function. An open list is never skipped: it
    // prints `here` itself, so it has to follow a route change from nothing to nothing.
    if (!anyShown && !state.listOpen && !pins.some((p) => p.page === here)) return;
    const drawn = new Set();
    const listed = new Set();
    let n = 0;
    let lost = 0;
    for (const p of pins) {
      if (p.page !== here) { forget(p); continue; }
      n++;
      const rects = resolveRects(p);
      if (!rects?.length) lost++;
      if (state.listOpen) listed.add(listRow(p, !rects?.length));
      if (!rects?.length) continue; // lost its anchor - listed, not drawn
      if (!p._button) {
        p._button = document.createElement('button');
        p._button.className = 'pin';
        p._button.textContent = p.n;
      }
      const d = p._button;
      const spot = pinSpot(rects[0]);
      d.classList.toggle('active', state.viewing === p);
      if (state.fresh === p) d.classList.add('in');
      d.style.left = `${spot.x}px`;
      d.style.top = `${spot.y}px`;
      if (d.parentNode !== el.pins) el.pins.appendChild(d);
      drawn.add(d);
    }
    for (const d of [...el.pins.children]) if (!drawn.has(d)) d.remove();
    // Only while open. Closing renders once more with nothing listed, and emptying the list then
    // collapsed the card to its header on the first frame of the fade - it went in two steps
    // instead of one. A closed list keeps its last rows; the next open brings them up to date.
    if (state.listOpen) for (const r of [...el.sideList.children]) if (!listed.has(r)) r.remove();
    state.fresh = null;
    anyShown = n > 0; // what the guard at the top reads: everything below writes the empty state

    const comments = `${n} comment${n === 1 ? '' : 's'}`;
    el.badge.textContent = n > 99 ? '99+' : String(n);
    el.badge.classList.toggle('on', n > 0);
    el.lsbtn.title = n ? `${comments} on this page - click to ${state.listOpen ? 'hide' : 'list'} them` : 'Comments on this page';
    if (state.listOpen) {
      el.sidePage.textContent = here;
      el.sidePage.title = here;
      el.sideEmpty.classList.toggle('on', !n);
      el.sideNote.textContent = n ? comments : '';
      if (lost) el.sideNote.append(Object.assign(document.createElement('span'),
        { className: 'gone', textContent: ` · ${lost} anchor${lost === 1 ? '' : 's'} not found` }));
    }
    const key = SHORTCUT ? ' (c)' : '';
    const to = cfg.repo ? ` - sending to ${cfg.repo}` : '';
    el.fab.title = n
      ? `${comments} on this page - click to add another${key}${to}`
      : `Comment on this page${key}${to}`;
  }

  /** A link struck through - the anchor this comment was tied to is not on the page. */
  const LOST_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" '
    + 'stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7M15 '
    + '7h2a5 5 0 0 1 4 8M8 12h4M3 3l18 18"/></svg>';

  /**
   * A comment's row in the list, kept on the pin like its button and only touched when something
   * about it changed. The mark already says which comment it is, and whether its anchor is lost,
   * so the line under the comment carries nothing but when it was left. Lost is a state a row can
   * move in and out of - an app re-rendering, a tab panel being opened - so the mark follows it.
   */
  function listRow(p, lost) {
    let row = p._row;
    const fresh = !row;
    if (fresh) {
      row = p._row = document.createElement('button');
      row.className = 'item';
      row.innerHTML = '<span class="item-mark"></span><span class="item-body">'
        + '<span class="item-text"></span><span class="item-meta"></span></span>';
      row.querySelector('.item-text').textContent = p.comment;
      row.querySelector('.item-meta').textContent = p.ts
        ? new Date(p.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';
    }
    if (fresh || row.classList.contains('lost') !== lost) {
      row.classList.toggle('lost', lost);
      const mark = row.querySelector('.item-mark');
      if (lost) mark.innerHTML = LOST_ICON;
      else mark.textContent = p.n;
      row.title = `#${p.n}${p.label ? ` · ${p.label}` : ''}${lost ? ' · anchor not found on this page' : ''}`;
    }
    row.classList.toggle('active', state.viewing === p);
    if (row.parentNode !== el.sideList) el.sideList.appendChild(row);
    return row;
  }

  /**
   * Before a listed comment is read back, its anchor is brought on screen - the list is how one
   * scrolled far away is reached at all. Instant, whatever the page's scroll-behavior says: the
   * panel is placed against where the anchor is once the scroll is over.
   */
  function reveal(p) {
    const rects = resolveRects(p);
    if (!rects?.length) return;
    const r = unionRect(rects);
    if (r.y < innerHeight - 40 && r.y + r.h > 40) return;
    const node = p._el || p._ref || p._range?.startContainer?.parentElement;
    if (node && !isPage(node)) node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    else scrollBy({ top: r.y + r.h / 2 - innerHeight / 2, behavior: 'instant' });
  }

  el.lsbtn.addEventListener('click', (e) => { if (e.isTrusted) setList(!state.listOpen); });
  el.sideClose.addEventListener('click', (e) => { if (e.isTrusted) setList(false); });

  el.sideList.addEventListener('click', (e) => {
    const row = e.target.closest?.('.item');
    const p = row && pins.find((x) => x._row === row);
    if (!p || !e.isTrusted) return;
    // Same rule as a pin: a comment half written is not thrown away for a look at an old one.
    if (composing() && el.ta.value.trim()) return;
    if (state.viewing === p) return closePopover();
    reveal(p);
    openPinView(p, rectOf(row.getBoundingClientRect()));
  });

  // Click, not hover: a tooltip that big is unreadable and it fires while you are trying to
  // point at the page underneath it.
  el.pins.addEventListener('click', (e) => {
    const p = pins.find((x) => x._button === e.target);
    if (!p || !e.isTrusted) return;
    e.preventDefault();
    e.stopPropagation();
    // A comment half written is not thrown away for a look at an old one.
    if (composing() && el.ta.value.trim()) return;
    if (state.viewing === p) closePopover();
    else openPinView(p);
  });
  /**
   * An app renders after the overlay loads, and re-renders whenever it likes. Resolving pins
   * once at startup asked the DOM about a page that did not exist yet: after a reload the
   * pins were simply absent, and then reappeared the moment anything happened to scroll,
   * which is the only thing that used to trigger a second look.
   *
   * So the DOM is watched. Bursts are coalesced into one repaint - a React commit is hundreds
   * of mutations and they all mean the same thing - and the observer only runs while this origin
   * actually has pins to place.
   *
   * The condition is `pins.length`, not "pins on this page", and it is not an oversight: under an
   * SPA the DOM mutation IS the only notice we get that the route changed, so an observer that
   * woke only for pages that already have pins would never see us arrive at one.
   */
  let repaintTimer = null;
  const queueRepaint = () => {
    if (repaintTimer) return;
    repaintTimer = setTimeout(() => {
      repaintTimer = null;
      // The DOM moved, so a quote that could not be found before is worth looking for again. Only
      // here: the scroll and resize path re-reads the same text and would find the same nothing.
      for (const p of pins) p._miss = false;
      renderPins();
      repaintHighlight(true);
      movePopover();
    }, 150);
  };

  let domWatch = null;
  /** Called on both sides of the condition: deleting the last pin has to take the observer down
   *  with it, or it goes on firing on every mutation the page makes for the life of the tab. */
  function watchDom() {
    if (!pins.length) { domWatch?.disconnect(); domWatch = null; return; }
    if (domWatch) return;
    domWatch = new MutationObserver(queueRepaint);
    // Our own paints happen inside the shadow root, which this never sees - no feedback loop.
    domWatch.observe(document.documentElement, { childList: true, subtree: true });
  }

  renderPins();
  watchDom();

  let frame = 0;
  const onViewportChange = () => {
    // The word tint has no live source to re-derive from - it belongs to a pointer position
    // that no longer means anything once the page has moved under it.
    if (state.word) { state.word = null; clearHighlight(true); }
    // What a region drag can catch has moved; measure it again on the next move.
    if (state.drag) state.drag.candidates = null;
    // Once per frame, however many scroll events arrive in it. Scroll events are dispatched
    // before the frame's animation callbacks, so this still paints in the same frame.
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderPins();
      repaintHighlight(true);
      movePopover();
    });
  };
  // Capture, so scrolling INSIDE a container is caught too. Scroll events do not bubble, so a
  // plain listener here only ever heard the window move - which in an app that scrolls a panel
  // rather than the document is exactly the thing that never happens.
  addEventListener('scroll', onViewportChange, { capture: true, passive: true });
  addEventListener('resize', onViewportChange, { passive: true });

  // ------------------------------------------------- the toolbar menu's settings
  /**
   * Turning an origin off takes effect at once, not on the next load: the tool steps out of comment
   * mode - a page left frozen under an invisible overlay would be the worst of both - drops any
   * panel and the list, and the whole overlay is hidden. Turning it back on shows it again. The
   * listeners stay; with the overlay hidden and picking off, none of them does anything, and `c`
   * checks the switch itself.
   */
  function setSwitchedOff(off) {
    if (off === switchedOff) return;
    switchedOff = off;
    if (off) {
      closePopover({ instant: true });
      setPicking(false, true);
      if (state.listOpen) setList(false);
    }
    host.style.display = off ? 'none' : '';
  }

  /** The menu's second switch: pins out of comment mode, faded, or not at all. The one being read stays. */
  const applySettings = (s) => {
    setSwitchedOff(Boolean(s.off));
    el.pins.classList.toggle('quiet', !s.idlePins);
  };

  // Both settings live in the extension's storage, which is the one source of truth: the menu writes
  // it, and every overlay follows it, whichever tab the change was made from.
  if (isolated) {
    const read = () => chrome.storage.local.get(['off', 'idlePins']).then((v) => applySettings({
      off: (v?.off || []).includes(location.origin), idlePins: v?.idlePins === true,
    }), () => {});
    try {
      read();
      chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && (c.off || c.idlePins)) read(); });
    } catch {}
  } else {
    // Passed on by the relay on pages the bridge serves; see content.js.
    window.addEventListener('message', (e) => {
      if (e.source === window && e.data?.__cc === 'settings') applySettings(e.data.settings || {});
    });
    const d = document.documentElement.dataset;
    if (d.ccSettings) try { applySettings(JSON.parse(d.ccSettings)); } catch {}
  }

  /**
   * Tests only - see test/overlay.test.mjs, which runs this exact file inside a DOM.
   *
   * Everything worth testing here is an anchor being described or found again, and every one of
   * those failures is silent: the pin simply never comes back. They are also all closed over
   * inside this IIFE, so a test can only reach them if the file hands them out.
   *
   * What it hands out is the rule: pure functions of what the caller passes in, each of which
   * reads the page's own DOM and returns a selector, a string, a plain object, a Range, or the
   * caller's own nodes back. Nothing here can send a comment, name the session, read the pins,
   * reach the extension, or return a node inside the closed shadow root - because on a
   * bridge-served page this script runs in the page world, where a hostile script can define
   * `window.__ccTest` before the overlay loads and be handed whatever is on this list. So the
   * list is exactly the set whose capability is "things the page could already do to itself",
   * and `cfg`, `state`, `el`, `host`, `sr`, `pins` and `askExtension` are deliberately absent.
   * Unused, it costs one `typeof`.
   */
  if (typeof window.__ccTest === 'function') {
    window.__ccTest({
      brief, cssSelector, describe, distinctClass, domPath,
      elementsInRegion, findQuote, pageKey, selectorStep, unique,
    });
  }
})();
