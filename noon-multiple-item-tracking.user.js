// ==UserScript==
// @name         Noon Control - Multiple Item Tracking (Unlimited + Auto Commas)
// @namespace    hussein.noon.tools
// @version      3.6
// @description  Search, Copy and Download any number of AWBs in one go: big requests are split into batches behind the scenes (a few at a time, in parallel) and merged (JSON for the table, TSV/CSV for Copy and Download). The batch size adapts to whatever the server accepts, so 700 or 7000 AWBs both work. Keeps huge AWB lists out of the address bar so refreshing the page never fails. Also adds commas to pasted AWBs.
// @author       husseinmahgoub5-netizen
// @homepageURL  https://github.com/husseinmahgoub5-netizen/noon-multiple-item-tracking
// @updateURL    https://raw.githubusercontent.com/husseinmahgoub5-netizen/noon-multiple-item-tracking/main/noon-multiple-item-tracking.user.js
// @downloadURL  https://raw.githubusercontent.com/husseinmahgoub5-netizen/noon-multiple-item-tracking/main/noon-multiple-item-tracking.user.js
// @match        https://express-control.noon.team/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
     SETTINGS
     ============================================================ */
  // AWBs sent in ONE request. The server answers 400 to a single
  // request with hundreds of AWBs, so this is deliberately small.
  // If a batch is still rejected the script halves it automatically
  // and remembers the size that worked for the next time.
  const BATCH_SIZE = 100;

  // Where the learned batch size is stored (localStorage).
  const REMEMBER_KEY = 'noon-mit-batch-size';

  // How many batches are sent at the same time. 700 AWBs = 7 requests:
  // 4 in parallel is ~2 waves instead of 7 one after another.
  const CONCURRENCY = 4;

  // The portal copies the AWB list into the page address. With thousands of AWBs the
  // address becomes huge and the server cuts the connection when you refresh
  // (ERR_CONNECTION_RESET). Lists longer than this many characters are removed from the
  // address bar (the search itself still works). Set to Infinity to turn this off.
  const MAX_ADDRESS_PARAM_CHARS = 3000;

  const PARAM = 'multiple_awb_nrs';
  // matches /report/multiple_item_tracking and any variant of the path,
  // plus any request that carries the AWB list parameter
  const TARGET = /multiple_item_tracking/i;
  // Statuses that usually mean "request too big / bad item": split and retry.
  // 0 = the connection was cut (some servers do that for very long URLs).
  const SPLIT_ON = new Set([0, 400, 413, 414, 431, 500, 502, 503, 504]);

  /* ============================================================
     ADDRESS BAR: keep huge AWB lists out of the page URL
     ============================================================ */
  function shortenUrl(url) {
    try {
      if (url == null) return url;
      const s = String(url);
      if (s.indexOf(PARAM + '=') < 0) return url;
      const u = new URL(s, location.href);
      const v = u.searchParams.get(PARAM);
      if (v && v.length > MAX_ADDRESS_PARAM_CHARS) {
        u.searchParams.delete(PARAM);
        return u.pathname + u.search + u.hash;
      }
    } catch (e) { /* ignore */ }
    return url;
  }

  ['pushState', 'replaceState'].forEach(function (name) {
    const orig = window.history[name];
    if (typeof orig !== 'function') return;
    window.history[name] = function (state, title, url) {
      return orig.call(this, state, title, shortenUrl(url));
    };
  });

  /* ============================================================
     1) AUTO COMMAS ON PASTE
     ============================================================ */
  function isAwbBox(el) {
    return el && /^(INPUT|TEXTAREA)$/.test(el.tagName) &&
           /awb/i.test(el.placeholder || '');
  }

  // new lines, spaces, tabs, commas, semicolons -> unique AWBs
  function parseList(text) {
    const parts = (text || '').split(/[\s,;]+/).filter(Boolean);
    return [...new Set(parts)];
  }

  // React ignores a plain el.value = ..., so use the native setter
  function setValue(el, value) {
    const proto = el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  document.addEventListener('paste', function (e) {
    const el = e.target;
    if (!isAwbBox(el)) return;
    const pasted = (e.clipboardData || window.clipboardData).getData('text');
    if (!pasted) return;
    e.preventDefault();
    const start = el.selectionStart ?? el.value.length;
    const end   = el.selectionEnd   ?? el.value.length;
    const combined = el.value.slice(0, start) + ' ' + pasted + ' ' + el.value.slice(end);
    setValue(el, parseList(combined).join(','));
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    const el = e.target;
    if (!isAwbBox(el)) return;
    const fixed = parseList(el.value).join(',');
    if (fixed !== el.value) setValue(el, fixed);
  }, true);

  /* ============================================================
     2) MERGING THE JSON RESPONSES
     The rows array is found automatically: the array whose total
     length across all batches is biggest (ignoring arrays that are
     identical in every batch, like column lists).
     ============================================================ */
  function collectArrays(node, path, depth, out) {
    if (Array.isArray(node)) { out.set(JSON.stringify(path), { path: path.slice(), arr: node }); return; }
    if (node && typeof node === 'object' && depth < 5) {
      for (const k of Object.keys(node)) {
        path.push(k);
        collectArrays(node[k], path, depth + 1, out);
        path.pop();
      }
    }
  }

  function setAt(obj, path, value) {
    if (!path.length) return value;
    let cur = obj;
    for (let i = 0; i < path.length - 1; i++) {
      if (cur[path[i]] == null || typeof cur[path[i]] !== 'object') cur[path[i]] = {};
      cur = cur[path[i]];
    }
    cur[path[path.length - 1]] = value;
    return obj;
  }

  function mergeJson(jsons) {
    const maps = jsons.map(j => { const m = new Map(); collectArrays(j, [], 0, m); return m; });
    const keys = new Set();
    maps.forEach(m => m.forEach((_, k) => keys.add(k)));

    let bestKey = null;
    let bestTotal = -1;
    keys.forEach(k => {
      const arrays = maps.map(m => (m.get(k) ? m.get(k).arr : []));
      const first = JSON.stringify(arrays.find(a => a.length) || []);
      const allSame = jsons.length > 1 && arrays.every(a => JSON.stringify(a) === first);
      if (allSame) return; // static metadata, not rows
      const total = arrays.reduce((s, a) => s + a.length, 0);
      if (total > bestTotal) { bestTotal = total; bestKey = k; }
    });
    if (bestKey === null) return null;

    const path = JSON.parse(bestKey);
    const rows = [];
    jsons.forEach((j, idx) => { const a = maps[idx].get(bestKey); if (a) rows.push(...a.arr); });

    const tIdx = maps.findIndex(m => m.has(bestKey));
    const template = JSON.parse(JSON.stringify(jsons[tIdx]));
    const tmplLen = maps[tIdx].get(bestKey).arr.length;
    const merged = setAt(template, path, rows);

    // fix simple counters (total / count ...) that matched the first batch size
    const counterRe = /^(total|count|total_count|totalcount|total_rows|row_count|rows_count|size)$/i;
    (function fix(node, depth) {
      if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 4) return;
      Object.keys(node).forEach(k => {
        if (typeof node[k] === 'number' && counterRe.test(k) && node[k] === tmplLen) node[k] = rows.length;
        else fix(node[k], depth + 1);
      });
    })(merged, 0);

    return merged;
  }

  // Text exports (tsv / csv): keep ONE header line, then every batch's rows
  async function mergeText(oks) {
    const texts = (await Promise.all(oks.map(r => r.clone().text()))).filter(t => t.trim());
    if (!texts.length) return oks[0];

    const norm = s => s.replace(/^\uFEFF/, '').replace(/\r$/, '');
    const firstLine = t => { const i = t.indexOf('\n'); return i < 0 ? t : t.slice(0, i); };
    const baseHeader = norm(firstLine(texts[0]));
    const nl = texts[0].indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    const endsNl = s => /\n$/.test(s);

    let out = texts[0];
    for (let k = 1; k < texts.length; k++) {
      let t = texts[k];
      if (norm(firstLine(t)) === baseHeader) {          // drop the repeated header
        const i = t.indexOf('\n');
        t = i < 0 ? '' : t.slice(i + 1);
      }
      if (!t.trim()) continue;
      if (!endsNl(out)) out += nl;
      out += t;
    }

    const headers = new Headers();
    ['content-type', 'content-disposition'].forEach(h => {
      const v = oks[0].headers.get(h);
      if (v) headers.set(h, v);
    });
    return new Response(out, { status: 200, statusText: 'OK', headers });
  }

  /* ============================================================
     3) THE FETCH HOOK
     ============================================================ */
  const origFetch = window.fetch;
  if (typeof origFetch !== 'function') return;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function passthrough(input, init) {
    return origFetch.call(window, input, init);
  }

  // learn the biggest batch the server accepted, so the next search
  // starts at a size that already worked
  function rememberedSize() {
    try {
      const n = parseInt(localStorage.getItem(REMEMBER_KEY) || '', 10);
      if (n > 0) return Math.min(BATCH_SIZE, n);
    } catch (e) { /* ignore */ }
    return BATCH_SIZE;
  }

  function rememberSize(n) {
    try { if (n > 0) localStorage.setItem(REMEMBER_KEY, String(Math.min(BATCH_SIZE, n))); } catch (e) { /* ignore */ }
  }

  function buildUrl(u, list) {
    const p = [];
    u.searchParams.forEach((v, k) => {
      if (k !== PARAM) p.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    p.push(PARAM + '=' + list.map(encodeURIComponent).join(','));
    return u.origin + u.pathname + '?' + p.join('&');
  }

  function send(url, input, init) {
    try {
      if (typeof input === 'string' || (typeof URL !== 'undefined' && input instanceof URL)) {
        return origFetch.call(window, url, init);
      }
      return origFetch.call(window, new Request(url, input), init);
    } catch (e) {
      // a Request that cannot be rebuilt: send the plain URL instead
      return origFetch.call(window, url);
    }
  }

  async function runBatched(u, awbs, input, init) {
    let eff = rememberedSize(); // batch size we start with
    let maxOk = 0;              // biggest batch that worked so far
    let singleFails = 0;
    let lastBad = null;
    let lastErr = null;
    let fatal = null;           // auth / other error: stop and show it
    let active = 0;             // batches on the wire right now
    const done = [];            // { start, res } to merge in paste order
    const rejected = [];
    const total = awbs.length;
    const started = Date.now();

    // hand the real failure back to the app
    const giveUp = res => {
      if (res.status === 0) throw lastErr;
      return res;
    };

    // one job per batch; a job the server refuses is split into two halves
    // that go back to the front of the queue
    const queue = [];
    for (let s = 0; s < total; s += eff) queue.push({ start: s, list: awbs.slice(s, s + eff) });

    async function handle(job) {
      const part = job.list;
      let tries429 = 0;

      for (;;) {
        let res;
        try {
          res = await send(buildUrl(u, part), input, init);
        } catch (err) {
          if (err && err.name === 'AbortError') throw err;
          lastErr = err;
          res = { ok: false, status: 0 }; // connection cut
        }

        if (res.ok) {
          done.push({ start: job.start, res });
          maxOk = Math.max(maxOk, part.length);
          singleFails = 0;
          return;
        }

        if (res.status === 429 && tries429 < 4) { // rate limited: wait and retry
          tries429++;
          await sleep(1500 * tries429);
          continue;
        }

        if (SPLIT_ON.has(res.status)) {
          lastBad = res;
          if (part.length > 1) {
            // the server refused this many AWBs: send halves instead
            const half = Math.max(1, Math.floor(part.length / 2));
            eff = Math.min(eff, half);
            queue.unshift(
              { start: job.start, list: part.slice(0, half) },
              { start: job.start + half, list: part.slice(half) }
            );
            return;
          }
          // one AWB alone is rejected: skip it
          rejected.push(part[0]);
          singleFails++;
          if (!done.length && singleFails >= 3) fatal = res;
          return;
        }

        fatal = res; // auth or other error: the app shows its normal message
        return;
      }
    }

    // a few batches at a time instead of one after the other
    async function worker() {
      for (;;) {
        if (fatal) return;
        if (!queue.length) {
          if (active === 0) return;
          await sleep(20); // wait for an in-flight batch that may add halves
          continue;
        }
        const job = queue.shift();
        active++;
        try { await handle(job); } finally { active--; }
      }
    }

    const pool = [];
    for (let k = 0; k < Math.min(CONCURRENCY, queue.length); k++) pool.push(worker());
    await Promise.all(pool);

    if (fatal && !done.length) return fatal;

    if (!done.length) return giveUp(lastBad);

    if (maxOk > 0) rememberSize(maxOk);

    done.sort((a, b) => a.start - b.start); // keep the order the AWBs were pasted in
    const responses = done.map(d => d.res);

    if (rejected.length) {
      console.warn('[tm-batch] AWBs rejected by the server (skipped):', rejected);
    }

    console.info('[tm-batch] ' + total + ' AWBs in ' + responses.length + ' request(s), batch=' + maxOk +
      ', ' + Math.round((Date.now() - started) / 100) / 10 + 's');

    if (responses.length === 1) return responses[0];

    const fmt = (u.searchParams.get('format') || '').toLowerCase();

    // Copy / Download: text exports (tsv, csv, txt)
    if (/^(tsv|csv|txt)$/.test(fmt)) return mergeText(responses);

    // Table search: JSON
    let jsons;
    try {
      jsons = await Promise.all(responses.map(r => r.clone().json()));
    } catch (e) {
      // not JSON: if it looks like text, merge it as text
      const ct = responses[0].headers.get('content-type') || '';
      if (/^text\/|csv|tab-separated|plain/i.test(ct)) return mergeText(responses);
      console.warn('[tm-batch] cannot merge this response format (' + (fmt || ct || 'unknown') +
        '). Returning the first batch only.', e);
      return responses[0];
    }
    const merged = mergeJson(jsons);
    if (!merged) {
      console.warn('[tm-batch] could not find the rows array to merge. Returning the first batch only.');
      return oks[0];
    }
    return new Response(JSON.stringify(merged), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
    });
  }

  function batched(u, awbs, input, init) {
    return runBatched(u, awbs, input, init).catch(err => {
      if (err && err.name === 'AbortError') throw err;
      console.error('[tm-batch] failed, falling back to the normal request', err);
      return passthrough(input, init);
    });
  }

  window.fetch = function (input, init) {
    let url = '';
    try { url = typeof input === 'string' ? input : ((input && input.url) || String(input)); } catch (e) { /* ignore */ }
    if (!TARGET.test(url) && url.indexOf(PARAM + '=') < 0) return origFetch.apply(this, arguments);

    let u;
    try { u = new URL(url, location.href); } catch (e) { return origFetch.apply(this, arguments); }
    const awbs = parseList(u.searchParams.get(PARAM));

    // one AWB (or none): nothing to split
    if (awbs.length < 2) return origFetch.apply(this, arguments);

    // long list: split from the start, one request per batch
    if (awbs.length > BATCH_SIZE) return batched(u, awbs, input, init);

    // short list: ask normally, but if the server still says "too big"
    // (400/413/414/431/5xx/connection cut) split it and retry
    const args = arguments;
    return origFetch.apply(this, args).then(function (res) {
      if (res && SPLIT_ON.has(res.status)) {
        console.warn('[tm-batch] ' + awbs.length + ' AWBs failed with ' + res.status + ', splitting…');
        return batched(u, awbs, input, init);
      }
      return res;
    });
  };
})();
