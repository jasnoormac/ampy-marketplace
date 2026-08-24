// background.js — the Ampy Facebook Marketplace bridge.
//
// Long-polls the local Ampy server for scrape jobs. When one arrives it
// opens the Marketplace search in a background tab, reads the result grid,
// and posts the listings back. Nothing leaves this machine: the only
// network calls are to Facebook (which your browser was going to talk to
// anyway) and to your own localhost server.
//
// Why this exists at all: Facebook has no buyer-side Marketplace API, and
// the alternative — a server scraping with a stored Facebook login — means
// handling credentials and getting blocked from a datacenter IP. Here the
// page is read in your own already-authenticated session, in your own
// browser, on pages your account can normally see. See
// lib/extensionBridge.js in the server for the other half.

const DEFAULT_SERVER = "http://localhost:3000";
// Facebook lazy-loads the grid, so one screenful isn't the whole result
// set. A few scrolls gets a useful page without grinding through
// everything Marketplace will eventually render.
const SCROLL_PASSES = 3;
const TAB_LOAD_TIMEOUT_MS = 20000;

let running = false;

async function getConfig() {
  const { serverUrl, enabled } = await chrome.storage.local.get(["serverUrl", "enabled"]);
  return {
    serverUrl: (serverUrl || DEFAULT_SERVER).replace(/\/+$/, ""),
    enabled: enabled !== false,
  };
}

async function setStatus(patch) {
  const prev = (await chrome.storage.local.get("status")).status || {};
  await chrome.storage.local.set({ status: { ...prev, ...patch, at: new Date().toISOString() } });
}

// --- the poll loop ----------------------------------------------------------

async function loop() {
  if (running) return;
  running = true;

  while (running) {
    const { serverUrl, enabled } = await getConfig();
    if (!enabled) {
      await sleep(3000);
      continue;
    }

    try {
      const res = await fetch(`${serverUrl}/api/extension/jobs`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`server responded ${res.status}`);

      const { jobs = [] } = await res.json();
      await setStatus({ connected: true, error: null });

      for (const job of jobs) {
        try {
          if (job.type === "craigslist_post") {
            await runCraigslistPostJob(job);
            await postResults(serverUrl, job.id, { status: "opened" });
            await setStatus({ lastJob: `craigslist post: ${job.draft?.postingTitle || ""}`, error: null });
          } else {
            const listings = await runJob(job);
            await postResults(serverUrl, job.id, { listings });
            await setStatus({ lastJob: job.query, lastCount: listings.length, error: null });
          }
        } catch (err) {
          await postResults(serverUrl, job.id, { error: err.message });
          await setStatus({ lastJob: job.query || job.type, error: err.message });
        }
      }
    } catch (err) {
      // Server down or restarting — back off rather than spinning.
      await setStatus({ connected: false, error: err.message });
      await sleep(5000);
    }
  }
}

async function postResults(serverUrl, jobId, payload) {
  await fetch(`${serverUrl}/api/extension/jobs/${jobId}/results`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// --- running one job --------------------------------------------------------

function searchUrl({ query, maxPrice, location }) {
  const base = location
    ? `https://www.facebook.com/marketplace/${encodeURIComponent(location)}/search`
    : "https://www.facebook.com/marketplace/search";
  const params = new URLSearchParams({ query: query || "" });
  if (maxPrice) params.set("maxPrice", String(Math.round(maxPrice)));
  params.set("sortBy", "best_match");
  return `${base}?${params.toString()}`;
}

async function runJob(job) {
  // A background tab: the scrape happens without stealing focus, but it's a
  // real tab in a real profile, not a headless session pretending to be one.
  const tab = await chrome.tabs.create({ url: searchUrl(job), active: false });
  try {
    await waitForTabLoad(tab.id);

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeMarketplace,
      args: [{ limit: job.limit || 20, scrollPasses: SCROLL_PASSES }],
    });

    if (result?.error) throw new Error(result.error);
    return result?.listings || [];
  } finally {
    // Always clean up, even if the scrape threw — otherwise a failing
    // query leaves a pile of orphan tabs behind.
    try { await chrome.tabs.remove(tab.id); } catch { /* already closed */ }
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Facebook tab didn't finish loading in time"));
    }, TAB_LOAD_TIMEOUT_MS);

    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // The grid renders after load; give React a beat to paint.
        setTimeout(resolve, 1500);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// --- Craigslist posting assist ---------------------------------------------
//
// Opens Craigslist's own posting flow in a FOREGROUND tab and pre-fills
// what it can on every step: the "for sale by owner" type radio, the
// category radio, then title / price / body on the posting form. It never
// clicks continue/submit, never touches CAPTCHA, and never fills contact
// fields (email/phone) — the human reviews every step and does the actual
// publishing. This is a form-filler, not a poster.

// The most recent posting draft lives in extension storage, and a
// TOP-LEVEL tab listener fills EVERY post.craigslist.org page load with
// it — so pre-fill works no matter how the tab was opened (extension job,
// the "Open Craigslist" button, or the user typing the URL). Top-level
// registration also survives MV3 service-worker sleep, which a
// per-job listener would not.
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

async function runCraigslistPostJob(job) {
  const draft = job.draft || {};
  await chrome.storage.local.set({ lastDraft: { draft, savedAt: Date.now() } });
  const tab = await chrome.tabs.create({
    url: draft.postUrl || "https://post.craigslist.org/",
    active: true,
  });
  // Bring the whole Chrome window forward — the user may be watching Ampy
  // in a different app, and a tab opening in a background window is
  // indistinguishable from nothing happening.
  try { await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true }); } catch { /* window gone */ }
}

async function reportFill(payload) {
  try {
    const { serverUrl } = await getConfig();
    await fetch(`${serverUrl}/api/extension/fill-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch { /* server down — nothing to do */ }
}

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete") return;
  const url = tab?.url || "";
  if (!/^https:\/\/[a-z0-9.-]+\.craigslist\.org\//i.test(url)) return;
  const { lastDraft } = await chrome.storage.local.get("lastDraft");
  if (!lastDraft?.draft) {
    await reportFill({ url, note: "no stored draft — publish or Auto-fill first" });
    return;
  }
  if (Date.now() - (lastDraft.savedAt || 0) > DRAFT_TTL_MS) {
    await reportFill({ url, note: "stored draft expired (>24h)" });
    return;
  }
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: fillCraigslistPage, args: [lastDraft.draft] });
    await reportFill({ url, note: "injected", filled: result || [] });
    await resolveSubAreaIfNeeded(tabId, lastDraft.draft);
  } catch (err) {
    await reportFill({ url, note: "injection failed", error: err?.message });
  }
});

// Sub-area choosers exist in every large metro with labels we can't know
// in advance. Read the options off the page, let the local server (via
// Mistral) pick the one containing the listing's ZIP, then pre-select it.
// Selection only — the user still reviews and clicks continue.
async function resolveSubAreaIfNeeded(tabId, draft) {
  if (!draft.postal) return;
  const [{ result: probe } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: readSubAreaOptions });
  if (!probe || !probe.options || probe.options.length < 2 || probe.alreadyPicked) return;
  const { serverUrl } = await getConfig();
  let choice = null;
  try {
    const response = await fetch(`${serverUrl}/api/extension/resolve-subarea`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ postal: draft.postal, location: draft.locationName, options: probe.options }),
    });
    choice = (await response.json())?.choice || null;
  } catch {
    return; // server unreachable — user picks by hand
  }
  if (!choice) return;
  await chrome.scripting.executeScript({ target: { tabId }, func: pickRadioByLabel, args: [choice] });
}

// Runs in the page: report sub-area options if this is a sub-area chooser.
function readSubAreaOptions() {
  if (!/location that fits best/i.test(document.body?.textContent || "")) return null;
  const radios = [...document.querySelectorAll('input[type="radio"]')];
  const labelOf = (radio) =>
    (radio.closest("label") || (radio.id ? document.querySelector(`label[for="${radio.id}"]`) : null) || radio.parentElement)?.textContent?.trim() || "";
  return {
    options: radios.map(labelOf).filter(Boolean),
    alreadyPicked: radios.some((radio) => radio.checked),
  };
}

// Runs in the page: select the radio whose label matches.
function pickRadioByLabel(labelText) {
  const target = labelText.toLowerCase();
  for (const radio of document.querySelectorAll('input[type="radio"]')) {
    const label = (radio.closest("label") || (radio.id ? document.querySelector(`label[for="${radio.id}"]`) : null) || radio.parentElement)?.textContent?.trim().toLowerCase() || "";
    if (label === target || label.includes(target) || target.includes(label)) {
      if (!radio.checked) radio.click();
      return true;
    }
  }
  return false;
}

// Runs INSIDE the Craigslist page. Fill-only: no navigation, no submits.
function fillCraigslistPage(draft) {
  const filled = [];
  const fire = (el) => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const setValue = (el, value) => {
    if (!el || el.value || !value) return false;
    el.value = value;
    fire(el);
    return true;
  };

  // The "which city / area would you like to post to?" chooser — a single
  // <select> of areas. Match by the market's display name (loosely: token
  // overlap, so "san francisco bay area" finds "SF bay area").
  // Pages can carry several <select>s (hidden templates, widget mirrors).
  // The city chooser is the VISIBLE one with by far the most options —
  // report a census of all of them so failures are diagnosable.
  const allSelects = [...document.querySelectorAll("select")];
  if (allSelects.length && /which city|area would you like to post/i.test(document.body?.textContent || "")) {
    filled.push(`selects: ${allSelects.map((sel) => `${sel.name || sel.id || "?"}(${sel.options.length}${sel.offsetParent ? ",visible" : ",hidden"})`).join(" ")}`);
  }
  const chooser = allSelects
    .filter((sel) => sel.options.length >= 10)
    .sort((a, b) => (b.offsetParent ? 1 : 0) - (a.offsetParent ? 1 : 0) || b.options.length - a.options.length)[0] || allSelects[0];
  if (chooser && /which city|area would you like to post/i.test(document.body?.textContent || "")) {
    const slug = String(draft.location || "").toLowerCase();
    const wanted = String(draft.locationName || draft.location || "").toLowerCase();
    const wantedTokens = wanted.split(/[^a-z0-9]+/).filter(Boolean);
    const squash = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");
    let best = null;
    let bestScore = 0;
    for (const option of chooser.options) {
      const text = option.textContent.trim().toLowerCase();
      if (!text) continue;
      // Strongest: Craigslist's own slug, either as the option value or
      // embedded in the squashed label ("SF bay area" -> "sfbayarea"
      // contains "sfbay"; "new york city" -> contains "newyork").
      if (slug && (option.value.toLowerCase() === slug || squash(text).includes(slug))) {
        best = option;
        bestScore = Infinity;
        break;
      }
      if (text === wanted || text.includes(wanted) || wanted.includes(text)) {
        best = option;
        bestScore = Infinity;
        break;
      }
      const textTokens = text.split(/[^a-z0-9]+/).filter(Boolean);
      const overlap = wantedTokens.filter((token) => textTokens.some((t) => t === token || t.startsWith(token) || token.startsWith(t))).length;
      if (overlap > bestScore) {
        bestScore = overlap;
        best = option;
      }
    }
    if (best && bestScore >= Math.max(1, Math.ceil(wantedTokens.length / 2))) {
      // Framework-controlled select (Craigslist's new flow hides the real
      // <select> under a custom widget): use the native prototype setter so
      // the framework's own change handling sees the update and re-renders.
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      if (nativeSetter) nativeSetter.call(chooser, best.value);
      else chooser.value = best.value;
      chooser.selectedIndex = best.index;
      fire(chooser);
      const shown = best.textContent.trim();
      // If a visible mirror widget still shows the old label, sync its text.
      const staleLabel = [...document.querySelectorAll("button, span, div")].find(
        (el) => el.childElementCount === 0 && el.offsetParent && el.textContent.trim() && el.textContent.trim() !== shown &&
          [...chooser.options].some((option) => option.textContent.trim() === el.textContent.trim())
      );
      if (staleLabel) {
        staleLabel.textContent = shown;
        filled.push("widget label synced");
      }
      filled.push(`city: ${shown} (select now shows: ${chooser.options[chooser.selectedIndex]?.textContent?.trim()})`);
    }
  }

  // Step pages (posting type, category) are radio lists with label text.
  const radios = [...document.querySelectorAll('input[type="radio"]')];
  const pick = (needle) => {
    for (const radio of radios) {
      const label = radio.closest("label") || (radio.id ? document.querySelector(`label[for="${radio.id}"]`) : null);
      const text = (label ? label.textContent : radio.parentElement?.textContent || "").toLowerCase();
      if (text.includes(needle)) {
        if (!radio.checked) radio.click();
        return true;
      }
    }
    return false;
  };
  if (radios.length) {
    if (pick("for sale by owner")) filled.push("type");
    const category = String(draft.category || "").replace(/ - by owner$/, "").toLowerCase();
    if (category && pick(category)) filled.push("category");
    // The sfbay "choose the location that fits best" page — pre-select
    // only; the user reviews and clicks continue like every other step.
    if (draft.subArea && /location that fits best/i.test(document.body?.textContent || "") && pick(draft.subArea)) {
      filled.push("sub-area");
    }
  }

  // The posting form. Unknown field names simply no-op if Craigslist
  // changes its markup. Contact fields are deliberately not touched.
  const q = (sel) => document.querySelector(sel);
  if (setValue(q('[name="PostingTitle"]'), draft.postingTitle)) filled.push("title");
  if (setValue(q('[name="Ask"]') || q('[name="price"]'), String(draft.price ?? ""))) filled.push("price");
  if (setValue(q('[name="PostingBody"]'), draft.body)) filled.push("body");
  if (setValue(q('[name="postal"]') || q('#postal_code'), draft.postal)) filled.push("zip");
  // Contact email (reply options). Comes from the user's own
  // CRAIGSLIST_CONTACT_EMAIL setting — never guessed.
  if (setValue(q('[name="FromEMail"]') || q('input[type="email"]'), draft.contactEmail)) filled.push("email");
  // Condition <select>: match option text ("good", "like new", ...).
  const conditionSelect = q('select[name="condition"]') || [...document.querySelectorAll("select")].find((sel) =>
    [...sel.options].some((option) => /like new|salvage/i.test(option.textContent)));
  if (conditionSelect && draft.condition && !conditionSelect.value) {
    const match = [...conditionSelect.options].find((option) => option.textContent.trim().toLowerCase() === draft.condition.toLowerCase());
    if (match) {
      conditionSelect.value = match.value;
      fire(conditionSelect);
      filled.push("condition");
    }
  }

  // Craigslist's image step: attach the Ampy listing photo(s) to the file
  // input. Fetches from the local Ampy server (CORS-open for exactly this),
  // builds File objects, and fires `change` so Craigslist's uploader runs —
  // the same thing that happens when a human picks the file. Skipped
  // cleanly if this page has no file input or the photos can't be fetched.
  const fileInput = document.querySelector('input[type="file"]');
  if (fileInput && Array.isArray(draft.imageUrls) && draft.imageUrls.length && !fileInput.files.length && !fileInput.dataset.ampyFilled) {
    fileInput.dataset.ampyFilled = "1";
    (async () => {
      try {
        const transfer = new DataTransfer();
        for (const url of draft.imageUrls.slice(0, 8)) {
          const response = await fetch(url);
          if (!response.ok) continue;
          const blob = await response.blob();
          const name = url.split("/").pop() || "photo.jpg";
          transfer.items.add(new File([blob], name, { type: blob.type || "image/jpeg" }));
        }
        if (transfer.files.length) {
          fileInput.files = transfer.files;
          fileInput.dispatchEvent(new Event("change", { bubbles: true }));
          console.log(`[Ampy] attached ${transfer.files.length} photo(s) to the uploader`);
        }
      } catch (err) {
        console.log(`[Ampy] photo attach failed (${err.message}) — add the photo manually`);
      }
    })();
    filled.push("photos (attaching)");
  }

  if (filled.length) console.log(`[Ampy] pre-filled: ${filled.join(", ")} — review and continue manually`);
  return filled;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the scrape -------------------------------------------------------------
//
// Injected into the Marketplace tab, so it must be entirely self-contained
// (no closure over anything above — Chrome serializes this function).
//
// Marketplace's class names are obfuscated and rotate, so keying on them
// would break weekly. The one stable anchor is the link every result card
// wraps: /marketplace/item/<id>. Find those, then read the card's own text
// lines. Same containment principle as the server's craigslistFetcher.js —
// when the markup shifts, only this function changes.
async function scrapeMarketplace({ limit, scrollPasses }) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  if (/\/login|\/checkpoint/.test(location.pathname)) {
    return { error: "Not signed in to Facebook in this browser profile." };
  }

  // Lazy-loaded grid: scroll a few times so there's more than one screenful.
  for (let i = 0; i < scrollPasses; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await wait(1200);
  }

  const anchors = [...document.querySelectorAll('a[href*="/marketplace/item/"]')];
  const byId = new Map();

  for (const a of anchors) {
    const idMatch = a.getAttribute("href")?.match(/\/marketplace\/item\/(\d+)/);
    if (!idMatch) continue;
    const itemId = idMatch[1];
    if (byId.has(itemId)) continue;

    // The anchor usually wraps the whole card. When it doesn't, walk up
    // until the text looks like a card rather than a bare title.
    let card = a;
    for (let up = 0; up < 3 && (card.innerText || "").split("\n").filter(Boolean).length < 2; up++) {
      if (!card.parentElement) break;
      card = card.parentElement;
    }

    const lines = (card.innerText || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;

    // Price: first line that's a currency amount. "Free" is a real
    // Marketplace price and parses to 0, which the server drops (a $0
    // listing isn't comparable), same as Craigslist's $0 handling.
    let price = null;
    let priceLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^free$/i.test(lines[i])) { price = 0; priceLine = i; break; }
      const m = lines[i].match(/^\$\s?([\d,]+)/);
      if (m) { price = Number(m[1].replace(/,/g, "")); priceLine = i; break; }
    }

    // Title: the most substantial line that isn't the price or an obvious
    // badge. Marketplace puts the title right after the price.
    const isNoise = (l) =>
      /^(free|sponsored|just listed|new listing|sold|pending)$/i.test(l) ||
      /^\$/.test(l) ||
      /^\d+\s*(mi|km|miles)/i.test(l);

    const candidates = lines.filter((l, i) => i !== priceLine && !isNoise(l));
    const title = candidates.sort((x, y) => y.length - x.length)[0] || lines[0];

    // Location: Marketplace renders it last, as "City, ST".
    const location =
      [...lines].reverse().find((l) => /,\s*[A-Z]{2}$/.test(l) || /^[A-Za-z .'-]+,\s*[A-Za-z ]+$/.test(l)) || "";

    const img = card.querySelector("img");

    byId.set(itemId, {
      itemId,
      title,
      price,
      location: location === title ? "" : location,
      imageUrl: img?.src || null,
      url: `https://www.facebook.com/marketplace/item/${itemId}/`,
    });

    if (byId.size >= limit) break;
  }

  if (byId.size === 0) {
    return {
      error:
        "No Marketplace result cards found. Either the search genuinely had no results, " +
        "or Facebook changed the grid markup (see scrapeMarketplace in the extension).",
    };
  }

  return { listings: [...byId.values()] };
}

// Kick the loop on install and on browser start, and once at load so
// reloading the extension from chrome://extensions restarts it too.
chrome.runtime.onInstalled.addListener(() => loop());
chrome.runtime.onStartup.addListener(() => loop());
loop();
