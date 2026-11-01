const $ = (id) => document.getElementById(id);
const OPT_IDS = ["maxPages", "delay", "cleanNumbers", "includeLinks", "alsoBasket"];
let tabId = null;

function toast(msg, ms = 2500) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

function opts() {
  return {
    maxPages: Math.max(1, parseInt($("maxPages").value, 10) || 50),
    delay: Math.max(0, parseInt($("delay").value, 10) || 0),
    cleanNumbers: $("cleanNumbers").checked,
    includeLinks: $("includeLinks").checked,
    alsoBasket: $("alsoBasket").checked,
  };
}

async function saveOpts() {
  await chrome.storage.local.set({ sxOpts: opts() });
}

async function loadOpts() {
  const { sxOpts } = await chrome.storage.local.get("sxOpts");
  if (!sxOpts) return;
  for (const k of OPT_IDS) {
    if (!(k in sxOpts)) continue;
    const el = $(k);
    if (el.type === "checkbox") el.checked = !!sxOpts[k];
    else el.value = sxOpts[k];
  }
}

async function call(cmd, args) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["scraper.js"] });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (c, a) => window.__SX.run(c, a),
    args: [cmd, args || {}],
  });
  return res?.result;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function scan() {
  $("list").innerHTML = '<div class="muted">Scanning…</div>';
  let res;
  try {
    res = await call("scan");
  } catch (e) {
    $("ctx").textContent = "Can't read this page.";
    $("list").innerHTML = `<div class="muted">${esc(e.message)}<br>Open a Semrush report tab, then click the icon again.</div>`;
    return;
  }
  const { tables, ctx } = res;
  $("ctx").textContent = [ctx.report, ctx.query, ctx.db].filter(Boolean).join(" · ") || "Current page";
  if (!tables.length) {
    $("list").innerHTML = '<div class="muted">No tables found yet. Wait for the report to finish loading, then press ↻.</div>';
    return;
  }
  $("list").innerHTML = "";
  for (const t of tables) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="t" title="${esc(t.title)}">${esc(t.title)}</div>
      <div class="h" title="${esc(t.headers.join(", "))}">${t.rows} rows on screen · ${t.columns} cols · ${esc(t.headers.join(", ") || "no headers")}</div>
      <div class="a">
        <button data-act="csv">CSV</button>
        <button data-act="copy" class="ghost">Copy</button>
        <button data-act="all" ${t.hasNext ? "" : 'class="ghost" title="No Next button found; this exports the current page only"'}>All pages${t.hasNext ? "" : " (1)"}</button>
        <button data-act="basket" class="ghost">+ Basket</button>
      </div>`;
    card.addEventListener("mouseenter", () => call("highlight", { index: t.index }).catch(() => {}));
    card.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => act(b.dataset.act, t.index, b)));
    $("list").appendChild(card);
  }
}

async function act(kind, index, btn) {
  btn.disabled = true;
  try {
    if (kind === "csv") {
      const r = await call("export", { index, opts: { ...opts(), action: "csv" } });
      toast(`Downloaded ${r.rows} rows`);
    } else if (kind === "copy") {
      const r = await call("export", { index, opts: { ...opts(), action: "copy" } });
      await navigator.clipboard.writeText(r.tsv);
      toast(`Copied ${r.rows} rows. Paste into Google Sheets or Excel.`);
    } else if (kind === "basket") {
      const r = await call("export", { index, opts: { ...opts(), action: "basket" } });
      toast(`Added ${r.rows} rows (basket: ${r.basket})`);
      refreshBasket();
    } else if (kind === "all") {
      await call("exportAll", { index, opts: opts() });
      toast("Running in the page. You can close this popup; the CSV downloads when it finishes.", 4000);
    }
  } catch (e) {
    toast("Error: " + e.message, 4000);
  } finally {
    btn.disabled = false;
  }
}

// ---- job status ----
function showJob(j) {
  if (!j || Date.now() - j.at > 10 * 60 * 1000) return $("job").classList.add("hidden");
  $("job").classList.remove("hidden");
  $("jobMsg").textContent = j.msg;
  $("stopJob").classList.toggle("hidden", j.state !== "running");
  if (j.state === "done" || j.state === "error") refreshBasket();
}

// ---- basket ----
async function refreshBasket() {
  const { sxBasket } = await chrome.storage.local.get("sxBasket");
  $("basketCount").textContent = sxBasket?.rows?.length || 0;
}

function csvCell(v) {
  v = String(v ?? "");
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

async function downloadBasket() {
  const { sxBasket } = await chrome.storage.local.get("sxBasket");
  if (!sxBasket?.rows?.length) return toast("Basket is empty");
  const h = sxBasket.headers;
  const lines = [h.map(csvCell).join(","), ...sxBasket.rows.map((r) => h.map((k) => csvCell(r[k])).join(","))];
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `semrush_basket_${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}.csv`;
  a.click();
  toast(`Downloaded ${sxBasket.rows.length} rows`);
}

// ---- init ----
document.addEventListener("DOMContentLoaded", async () => {
  await loadOpts();
  OPT_IDS.forEach((k) => $(k).addEventListener("change", saveOpts));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;

  $("rescan").onclick = scan;
  $("stopJob").onclick = () => call("stop").then(() => toast("Stopping… the CSV of rows so far will download."));
  $("exportEverything").onclick = async (e) => {
    e.target.disabled = true;
    try {
      const r = await call("exportEverything", { opts: opts() });
      toast(`Downloaded ${r.tables} CSV file(s), ${r.rows} rows`);
    } catch (err) {
      toast("Error: " + err.message, 4000);
    } finally {
      e.target.disabled = false;
    }
  };
  $("basketDl").onclick = downloadBasket;
  $("basketClear").onclick = async () => {
    if (!confirm("Clear all rows in the basket?")) return;
    await chrome.storage.local.remove("sxBasket");
    refreshBasket();
  };

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.sxJob) showJob(ch.sxJob.newValue);
    if (ch.sxBasket) refreshBasket();
  });
  const { sxJob } = await chrome.storage.local.get("sxJob");
  showJob(sxJob);
  refreshBasket();
  scan();
});
