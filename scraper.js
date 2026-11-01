// Semrush Table Exporter: page-side engine.
// Injected on demand by the popup (activeTab), so it works on semrush.com and on any mirror domain.
// Reads what is rendered in the page: Intergalactic DataTables (role=grid/table) and plain <table>s.
(() => {
  if (window.__SX) return;

  const TABLE_SEL = '[data-ui-name="DataTable"], [role="grid"], [role="table"], table';
  const ROW_SEL = '[role="row"], [data-ui-name="Body.Row"], tr';
  const CELL_SEL = '[role="gridcell"], [role="cell"], [role="rowheader"], [data-ui-name="Body.Cell"], td';
  const HEAD_SEL = '[role="columnheader"], [data-ui-name="Head.Column"], th';
  const TITLE_SEL = '[data-at="widget-title"], [data-ui-name="Title"], h1, h2, h3, h4';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => String(s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  const textOf = (el) => clean(el.innerText ?? el.textContent);

  let tables = [];
  let job = { running: false, stop: false };

  // ---------- detection ----------

  function outermost(nodes) {
    return nodes.filter((n) => !nodes.some((o) => o !== n && o.contains(n)));
  }

  function headerCells(root) {
    const all = Array.from(root.querySelectorAll(HEAD_SEL));
    // Leaf headers only (grouped headers contain child headers)
    return all.filter((h) => !all.some((o) => o !== h && h.contains(o)));
  }

  function bodyRows(root) {
    const rows = outermost(Array.from(root.querySelectorAll(ROW_SEL)));
    return rows.filter((r) => !r.querySelector(HEAD_SEL) && !r.closest("thead, [data-ui-name='Head']"));
  }

  function rowCells(row) {
    let cells = outermost(Array.from(row.querySelectorAll(CELL_SEL)));
    if (!cells.length) cells = Array.from(row.children);
    return cells;
  }

  function headerText(h, root) {
    let t = textOf(h);
    const group = h.parentElement && h.parentElement.closest(HEAD_SEL);
    if (group && root.contains(group)) {
      const g = clean(Array.from(group.childNodes).filter((n) => n.nodeType === 3 || !n.matches?.(HEAD_SEL)).map((n) => n.textContent).join(" "));
      if (g && g !== t) t = `${g} - ${t}`;
    }
    return t;
  }

  function titleFor(root, i) {
    let el = root;
    for (let depth = 0; depth < 8 && el && el !== document.body; depth++) {
      el = el.parentElement;
      if (!el) break;
      const cands = Array.from(el.querySelectorAll(TITLE_SEL)).filter((t) => !root.contains(t) && textOf(t));
      if (cands.length) {
        // closest heading that comes before the table
        const before = cands.filter((t) => t.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING);
        const pick = before.length ? before[before.length - 1] : cands[0];
        return textOf(pick).slice(0, 80);
      }
    }
    return `Table ${i + 1}`;
  }

  function scan() {
    const cands = Array.from(document.querySelectorAll(TABLE_SEL)).filter((el) => {
      if (el.closest("#__sx_hud")) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    tables = outermost(cands).filter((t) => bodyRows(t).length > 0);
    return tables.map((t, i) => {
      const heads = headerCells(t).map((h) => headerText(h, t)).filter(Boolean);
      return {
        index: i,
        title: titleFor(t, i),
        headers: heads.slice(0, 12),
        columns: heads.length,
        rows: bodyRows(t).length,
        hasNext: !!findNext(t),
      };
    });
  }

  // ---------- extraction ----------

  function trendOf(cell) {
    const rects = Array.from(cell.querySelectorAll("svg rect"));
    if (rects.length < 3) return "";
    const hs = rects.map((r) => parseFloat(r.getAttribute("height")) || 0);
    const max = Math.max(...hs);
    if (!max) return "";
    return hs.map((h) => (h / max).toFixed(2)).join(";");
  }

  function linkOf(cell) {
    for (const a of cell.querySelectorAll("a[href]")) {
      try {
        const u = new URL(a.href, location.href);
        if (/^https?:$/.test(u.protocol) && u.hostname !== location.hostname) return u.href;
      } catch (_) {}
    }
    return "";
  }

  function cellValue(cell) {
    const t = textOf(cell);
    if (t) return t;
    return trendOf(cell);
  }

  // Raw read of what is currently rendered
  function readTable(root) {
    const heads = headerCells(root).map((h) => headerText(h, root));
    const rows = bodyRows(root).map((r) => {
      const cells = rowCells(r);
      return {
        key: r.getAttribute("aria-rowindex") || "",
        values: cells.map(cellValue),
        links: cells.map(linkOf),
      };
    });
    return { heads, rows };
  }

  function rowKey(r) {
    return r.key ? "i" + r.key : "t" + r.values.join("\u0001");
  }

  function scrollContainer(root) {
    let el = bodyRows(root)[0] || root;
    while (el && el !== document.body) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 20) return el;
      el = el.parentElement;
    }
    return null;
  }

  // Reads the whole table, scrolling inner virtualised containers so lazily rendered rows are captured.
  async function collect(root) {
    const first = readTable(root);
    const seen = new Map();
    const add = (snap) => snap.rows.forEach((r) => { const k = rowKey(r); if (!seen.has(k)) seen.set(k, r); });
    add(first);
    const box = scrollContainer(root);
    if (box) {
      const start = box.scrollTop;
      box.scrollTop = 0;
      await sleep(250);
      add(readTable(root));
      let idle = 0;
      for (let step = 0; idle < 3 && step < 400 && !job.stop; step++) {
        const prevTop = box.scrollTop;
        box.scrollTop += Math.max(100, box.clientHeight * 0.8);
        await sleep(350);
        add(readTable(root));
        idle = box.scrollTop === prevTop ? idle + 1 : 0;
      }
      box.scrollTop = start;
    }
    return { heads: first.heads, rows: Array.from(seen.values()) };
  }

  function expandNumber(v) {
    let m = v.match(/^(-?)\$?(\d{1,3}(?:,\d{3})+)(\.\d+)?$/);
    if (m) return m[1] + m[2].replace(/,/g, "") + (m[3] || "");
    m = v.match(/^(-?)\$?(\d+(?:\.\d+)?)\s?([KMB])$/);
    if (m) {
      const mult = { K: 1e3, M: 1e6, B: 1e9 }[m[3]];
      return m[1] + String(Math.round(parseFloat(m[2]) * mult));
    }
    return v;
  }

  // Turns raw reads into header + matrix, aligned and cleaned
  function shape(snap, opts) {
    const width = Math.max(snap.heads.length, ...snap.rows.map((r) => r.values.length), 0);
    // Some tables have an extra leading header (e.g. checkbox) or trailing one; align from the right
    // when body rows are narrower than headers.
    let heads = snap.heads.slice();
    const bodyW = Math.max(...snap.rows.map((r) => r.values.length), 0);
    if (heads.length > bodyW && bodyW > 0) heads = heads.slice(heads.length - bodyW);
    while (heads.length < width) heads.push("");

    let cols = heads.map((h, i) => ({
      name: h || `Column ${i + 1}`,
      named: !!h,
      vals: snap.rows.map((r) => r.values[i] ?? ""),
      links: snap.rows.map((r) => r.links[i] ?? ""),
    }));
    cols = cols.filter((c) => c.vals.some((v) => v !== ""));

    const out = [];
    for (const c of cols) {
      out.push({ name: c.name, vals: opts.cleanNumbers ? c.vals.map(expandNumber) : c.vals });
      if (opts.includeLinks && c.links.some((l) => l && !c.vals.includes(l))) {
        out.push({ name: `${c.name} URL`, vals: c.links });
      }
    }
    // unique header names
    const used = {};
    out.forEach((c) => { used[c.name] = (used[c.name] || 0) + 1; if (used[c.name] > 1) c.name += ` (${used[c.name]})`; });
    return {
      headers: out.map((c) => c.name),
      rows: snap.rows.map((_, i) => out.map((c) => c.vals[i])),
    };
  }

  // ---------- pagination ----------

  function isDisabled(b) {
    return b.disabled || b.getAttribute("aria-disabled") === "true" || b.getAttribute("data-disabled") != null ||
      /disabled/i.test(b.className || "");
  }

  const NEXT_SEL = '[data-ui-name="Pagination.NextPage"], button[aria-label*="next" i], a[aria-label*="next" i], [data-test*="next" i], button[title*="next" i]';

  // The table that "owns" an element: the one containing it, else the nearest one before it.
  function ownerTable(el, scope) {
    const ts = outermost(Array.from(scope.querySelectorAll(TABLE_SEL)));
    let owner = null;
    for (const t of ts) {
      if (t.contains(el)) return t;
      if (t.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) owner = t;
    }
    return owner;
  }

  function findNext(root) {
    let scope = root;
    for (let depth = 0; depth < 8 && scope && scope !== document.documentElement; depth++) {
      const cands = Array.from(scope.querySelectorAll(NEXT_SEL)).concat(
        Array.from(scope.querySelectorAll("button, a")).filter((b) => /^(next|next page|›|»|→)$/i.test(textOf(b)))
      );
      const mine = cands.filter((b) => {
        const o = ownerTable(b, scope);
        return o === root || (o && o.contains(root)) || (o && root.contains(o));
      });
      if (mine.length) return mine[0];
      scope = scope.parentElement;
    }
    return null;
  }

  function signature(root) {
    return bodyRows(root).slice(0, 3).map(textOf).join("|");
  }

  function relocate(headSig) {
    scan();
    return tables.find((t) => headerCells(t).map((h) => headerText(h, t)).join("|") === headSig) || tables[0];
  }

  async function waitForChange(root, oldSig, headSig, timeout = 25000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout && !job.stop) {
      await sleep(300);
      if (!root.isConnected) root = relocate(headSig);
      if (!root) continue;
      const s = signature(root);
      if (s && s !== oldSig && bodyRows(root).length) {
        await sleep(400); // let the rest of the rows paint
        return root;
      }
    }
    return null;
  }

  // ---------- output ----------

  function csvCell(v) {
    v = String(v ?? "");
    return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }
  const toCSV = (h, rows) => [h, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  const toTSV = (h, rows) => [h, ...rows].map((r) => r.map((v) => String(v ?? "").replace(/[\t\n\r]+/g, " ")).join("\t")).join("\n");

  function slug(s) {
    return clean(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  }

  function context() {
    const p = new URLSearchParams(location.search);
    const report = (location.pathname.match(/analytics\/([^/]+)/) || [])[1] || location.pathname.split("/").filter(Boolean)[0] || "page";
    const query = p.get("q") || p.get("domain") || p.get("phrase") || "";
    const db = p.get("db") || "";
    return { report, query, db };
  }

  function fileName(title) {
    const c = context();
    const d = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
    return ["semrush", c.report, c.query, c.db, title].map(slug).filter(Boolean).join("_") + `_${d}.csv`;
  }

  function download(name, text) {
    const blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  async function addToBasket(shaped, title) {
    if (!globalThis.chrome?.storage?.local) return 0;
    const c = context();
    const { sxBasket } = await chrome.storage.local.get("sxBasket");
    const basket = sxBasket || { headers: [], rows: [] };
    const headers = ["Report", "Query", "Database", "Table", ...shaped.headers];
    headers.forEach((h) => { if (!basket.headers.includes(h)) basket.headers.push(h); });
    shaped.rows.forEach((r) => {
      const obj = { Report: c.report, Query: c.query, Database: c.db, Table: title };
      shaped.headers.forEach((h, i) => (obj[h] = r[i]));
      basket.rows.push(obj);
    });
    await chrome.storage.local.set({ sxBasket: basket });
    return basket.rows.length;
  }

  // ---------- HUD ----------

  function hud(msg, done) {
    let host = document.getElementById("__sx_hud");
    if (!host) {
      host = document.createElement("div");
      host.id = "__sx_hud";
      host.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:2147483647;";
      const sh = host.attachShadow({ mode: "open" });
      sh.innerHTML = `<style>
        .b{font:13px/1.4 -apple-system,system-ui,sans-serif;background:#111827;color:#f9fafb;padding:10px 12px;border-radius:10px;
           box-shadow:0 6px 24px rgba(0,0,0,.3);display:flex;gap:10px;align-items:center;max-width:360px}
        button{font:inherit;border:0;border-radius:6px;padding:4px 10px;cursor:pointer;background:#ef4444;color:#fff}
        button.x{background:#374151}</style>
        <div class="b"><span id="m"></span><button id="s">Stop</button></div>`;
      sh.getElementById("s").onclick = () => {
        if (job.running) job.stop = true; else host.remove();
      };
      document.documentElement.appendChild(host);
    }
    const sh = host.shadowRoot;
    sh.getElementById("m").textContent = msg;
    const b = sh.getElementById("s");
    b.textContent = done ? "Close" : "Stop";
    b.className = done ? "x" : "";
    if (done) setTimeout(() => host.isConnected && !job.running && host.remove(), 8000);
  }

  async function report(state) {
    if (globalThis.chrome?.storage?.local) await chrome.storage.local.set({ sxJob: { ...state, at: Date.now() } });
  }

  // ---------- commands ----------

  function highlight(i) {
    document.getElementById("__sx_hl")?.remove();
    const t = tables[i];
    if (!t || !t.isConnected) return;
    t.scrollIntoView({ block: "center", behavior: "smooth" });
    const box = document.createElement("div");
    box.id = "__sx_hl";
    document.documentElement.appendChild(box);
    const place = () => {
      const r = t.getBoundingClientRect();
      box.style.cssText = `position:fixed;pointer-events:none;z-index:2147483646;border:3px solid #10b981;border-radius:6px;
        background:rgba(16,185,129,.08);left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px`;
    };
    place();
    const iv = setInterval(place, 100);
    setTimeout(() => { clearInterval(iv); box.remove(); }, 2500);
  }

  async function exportCurrent(i, opts) {
    const root = tables[i];
    if (!root || !root.isConnected) throw new Error("Table is gone. Rescan.");
    const shaped = shape(await collect(root), opts);
    const title = titleFor(root, i);
    if (opts.action === "copy") return { tsv: toTSV(shaped.headers, shaped.rows), rows: shaped.rows.length };
    if (opts.action === "basket") return { rows: shaped.rows.length, basket: await addToBasket(shaped, title) };
    download(fileName(title), toCSV(shaped.headers, shaped.rows));
    return { rows: shaped.rows.length };
  }

  async function exportAllPages(i, opts) {
    if (job.running) throw new Error("A job is already running on this tab.");
    let root = tables[i];
    if (!root || !root.isConnected) throw new Error("Table is gone. Rescan.");
    job = { running: true, stop: false };
    const title = titleFor(root, i);
    const headSig = headerCells(root).map((h) => headerText(h, root)).join("|");
    const merged = { heads: null, rows: [] };
    const seen = new Set();
    let page = 0, stopReason = "done";
    try {
      while (true) {
        page++;
        const snap = await collect(root);
        if (!merged.heads || snap.heads.length > merged.heads.length) merged.heads = snap.heads;
        let added = 0;
        for (const r of snap.rows) {
          const k = "t" + r.values.join("\u0001");
          if (!seen.has(k)) { seen.add(k); merged.rows.push(r); added++; }
        }
        const msg = `Page ${page}: ${merged.rows.length} rows`;
        hud(msg); report({ state: "running", page, rows: merged.rows.length, msg });

        if (job.stop) { stopReason = "stopped"; break; }
        if (page >= opts.maxPages) { stopReason = "page limit"; break; }
        if (added === 0 && page > 1) { stopReason = "no new rows"; break; }
        const next = findNext(root);
        if (!next || isDisabled(next)) { stopReason = "last page"; break; }

        await sleep(opts.delay);
        const sig = signature(root);
        next.scrollIntoView({ block: "center" });
        next.click();
        const nr = await waitForChange(root, sig, headSig);
        if (!nr) { stopReason = job.stop ? "stopped" : "page did not load (limit or popup?)"; break; }
        root = nr;
      }
      const shaped = shape(merged, opts);
      download(fileName(title + "-all"), toCSV(shaped.headers, shaped.rows));
      let extra = "";
      if (opts.alsoBasket) extra = `, basket ${await addToBasket(shaped, title)}`;
      const msg = `Done: ${shaped.rows.length} rows, ${page} page(s) (${stopReason})${extra}`;
      hud(msg, true); report({ state: "done", page, rows: shaped.rows.length, msg });
    } catch (e) {
      hud("Error: " + e.message, true); report({ state: "error", msg: e.message });
    } finally {
      job.running = false;
    }
    return { started: true };
  }

  async function exportEverything(opts) {
    scan();
    let total = 0;
    for (let i = 0; i < tables.length; i++) {
      const r = await exportCurrent(i, { ...opts, action: "csv" });
      total += r.rows;
      await sleep(300);
    }
    return { tables: tables.length, rows: total };
  }

  window.__SX = {
    async run(cmd, args = {}) {
      switch (cmd) {
        case "scan": return { tables: scan(), ctx: context(), running: job.running };
        case "highlight": return highlight(args.index);
        case "export": return exportCurrent(args.index, args.opts);
        case "exportAll": exportAllPages(args.index, args.opts); return { started: true };
        case "exportEverything": return exportEverything(args.opts);
        case "stop": job.stop = true; return { ok: true };
        default: throw new Error("Unknown command " + cmd);
      }
    },
    _test: { scan, readTable, shape, collect, toCSV, findNext, expandNumber, tables: () => tables },
  };
})();
