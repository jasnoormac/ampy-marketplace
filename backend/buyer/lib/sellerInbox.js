// lib/sellerInbox.js
//
// The seller agent's INBOUND channel: humans who saw a listing (e.g. the
// Craigslist cross-post) text the seller's number; this module reads those
// incoming iMessages, works out which listing they're about, asks the
// Python seller agent (which holds the listing's real asking price and
// hidden floor) for the reply, and sends it back over iMessage.
//
// Mirror image of the buyer side in lib/imessage.js, and it reuses that
// module's plumbing wholesale: chat.db reading, AppleScript sending, the
// per-handle/day caps, dedupe, audit log, and IMESSAGE_DRY_RUN.
//
// GUARDRAILS (in code, not vibes):
//   - A message only gets an auto-reply if Mistral confidently matches it
//     to one of OUR active listings. Everything else (family, OTPs,
//     random texts) is ignored and never answered.
//   - The agent NEVER closes a sale. When the seller agent would accept
//     an offer, we reply with a hold ("let me confirm and get back to
//     you"), flag the thread as pendingConfirmation, and leave the actual
//     yes to the human. See PENDING_HOLD_REPLY.
//   - All sends flow through imessage.sendMessage -> its daily caps and
//     append-only audit log apply unchanged.
//
// Off by default: set SELLER_IMESSAGE_AUTOREPLY=true in the root .env.
// Reading incoming messages needs Full Disk Access (see checkSetup).

const fs = require("fs");
const path = require("path");
const imessage = require("./imessage.js");
const listingStore = require("./listingStore.js");
const llm = require("./llm.js");

const STATE_PATH = path.join(__dirname, "..", "data", "sellerInbox.json");
const POLL_MS = Number(process.env.SELLER_INBOX_POLL_MS || 20000);
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const PENDING_HOLD_REPLY =
  "That works on my end — let me just confirm it's still available and I'll get right back to you to lock it in.";

const enabled = () =>
  String(process.env.SELLER_IMESSAGE_AUTOREPLY || "").toLowerCase() === "true";

function sellerAgentUrl() {
  return (process.env.SELLER_AGENT_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
}

// --- state -------------------------------------------------------------

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { lastSeenApple: null, threads: {} };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// --- reading new incoming messages --------------------------------------

const msToApple = (ms) => (ms - APPLE_EPOCH_MS) * 1e6;
const appleToIso = (apple) => new Date(APPLE_EPOCH_MS + apple / 1e6).toISOString();

async function readIncomingSince(sinceApple) {
  const sql = `
    SELECT m.ROWID              AS rowid,
           m.text               AS text,
           hex(m.attributedBody) AS body_hex,
           m.date               AS apple_date,
           h.id                 AS handle
    FROM message m
    JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.is_from_me = 0 AND m.date > :since
    ORDER BY m.date ASC
    LIMIT 100;
  `;
  const rows = await imessage.queryChatDb(sql, { since: sinceApple });
  return rows
    .map((row) => ({
      handle: row.handle,
      appleDate: Number(row.apple_date),
      at: appleToIso(Number(row.apple_date)),
      text: (row.text || imessage.decodeAttributedBody(row.body_hex) || "").trim(),
    }))
    .filter((message) => message.text);
}

// --- matching a message to a listing -------------------------------------

const MATCH_SCHEMA = {
  type: "object",
  properties: { listingId: { type: ["string", "null"] } },
  required: ["listingId"],
};

async function matchListing(text, listings) {
  if (!listings.length) return null;
  // Repeated publishes leave duplicate listings with identical titles; a
  // menu with three copies of the same item reads as ambiguity and forces
  // the (correct) cautious null. Offer one candidate per title — the
  // newest — so a duplicate is one item, while the cautious rule stays.
  const newestByTitle = new Map();
  for (const listing of listings) {
    const key = (listing.title || "").toLowerCase();
    const existing = newestByTitle.get(key);
    if (!existing || new Date(listing.postedAt) > new Date(existing.postedAt)) newestByTitle.set(key, listing);
  }
  const candidates = [...newestByTitle.values()];
  const menu = candidates.map((l) => ({ listingId: l.id, title: l.title, price: l.price }));
  try {
    const out = await llm.chatJSON({
      maxTokens: 128,
      schema: MATCH_SCHEMA,
      system:
        "You triage a seller's incoming text messages. Given the seller's active listings and one " +
        "incoming message, decide whether the message is a prospective buyer asking about ONE of " +
        "those listings (availability, condition, price, an offer, pickup). If clearly yes, return " +
        "that listingId. For anything else — personal messages, other topics, ambiguous texts — " +
        "return null. When in doubt, null: a missed reply is fine, a wrong auto-reply is not.",
      user: JSON.stringify({ message: text.slice(0, 1000), listings: menu }),
    });
    const id = out.listingId;
    const hit = candidates.find((l) => l.id === id) || null;
    if (!hit) console.log(`[sellerInbox] matcher returned ${JSON.stringify(id)} — no listing hit`);
    return hit;
  } catch (err) {
    // Stay silent to the texter, but never silent in the logs.
    console.warn(`[sellerInbox] match failed: ${err.message}`);
    return null;
  }
}

// --- generating the reply -------------------------------------------------

function targetPrice(listing) {
  const floor = listing.minAcceptablePrice ?? Math.round(listing.price * 0.7);
  return Math.min(listing.price, Math.max(floor, Math.round(listing.price * 0.9)));
}

async function sellerReply(listing, thread, buyerText) {
  const floor = listing.minAcceptablePrice ?? Math.round(listing.price * 0.7);
  const response = await fetch(`${sellerAgentUrl()}/seller/negotiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      item_description: `${listing.title}. ${listing.description || ""}`.trim().slice(0, 4000),
      buyer_message: buyerText.slice(0, 4000),
      listing_price: listing.price,
      target_price: targetPrice(listing),
      floor_price: floor,
      currency: "USD",
      turn_number: Math.min(50, Math.floor(thread.lines.length / 2) + 1),
      conversation: thread.lines.slice(-30).map((line) => ({ role: line.role, content: line.text.slice(0, 4000) })),
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`seller agent ${response.status}`);
  const payload = await response.json();
  return {
    text: String(payload.reply || "").trim(),
    action: String(payload.action || "counter"),
  };
}

// --- the scan ---------------------------------------------------------------

let scanning = false;

async function scanOnce({ force = false } = {}) {
  if (!force && !enabled()) return { ok: false, skipped: "SELLER_IMESSAGE_AUTOREPLY is not true" };
  const setup = await imessage.checkSetup();
  if (!setup.canReadReplies) return { ok: false, needsSetup: true, issues: setup.issues };
  if (scanning) return { ok: false, skipped: "scan already running" };
  scanning = true;

  try {
    const state = readState();
    // First ever scan: start from now — never replay message history.
    if (state.lastSeenApple == null) {
      state.lastSeenApple = msToApple(Date.now());
      writeState(state);
      return { ok: true, processed: 0, note: "initialized — watching from now on" };
    }

    const incoming = await readIncomingSince(state.lastSeenApple);
    const listings = listingStore.listAll().filter((l) => l.title && l.price);
    let processed = 0;
    let replied = 0;

    for (const message of incoming) {
      state.lastSeenApple = Math.max(state.lastSeenApple, message.appleDate);
      processed += 1;

      const thread = state.threads[message.handle] || { listingId: null, lines: [], pendingConfirmation: false };
      let listing = thread.listingId ? listingStore.getById(thread.listingId) : null;
      if (!listing) listing = await matchListing(message.text, listings);
      if (!listing) continue; // not about our listings — never auto-reply

      thread.listingId = listing.id;
      thread.lines.push({ role: "buyer", text: message.text, at: message.at });

      let reply;
      try {
        reply = await sellerReply(listing, thread, message.text);
      } catch (err) {
        console.warn(`[sellerInbox] seller agent unreachable (${err.message}) — no reply sent`);
        state.threads[message.handle] = thread;
        continue;
      }

      // The agent never closes the deal — a would-be acceptance becomes a
      // hold, and the human confirms (or doesn't) themselves.
      let outbound = reply.text;
      if (reply.action === "accept") {
        outbound = PENDING_HOLD_REPLY;
        thread.pendingConfirmation = true;
        console.log(
          `[sellerInbox] ${message.handle} is ready to buy "${listing.title}" — held for your confirmation (see /api/seller-inbox/status)`
        );
      }

      if (outbound) {
        const sent = await imessage.sendMessage({
          handle: message.handle,
          text: outbound,
          listingId: listing.id,
          meta: { source: "sellerInbox", action: reply.action },
        });
        if (sent.ok) {
          replied += 1;
          thread.lines.push({ role: "seller", text: outbound, at: new Date().toISOString() });
          listingStore.recordInquiry(listing.id);
        } else {
          console.warn(`[sellerInbox] send blocked: ${sent.error}`);
        }
      }
      state.threads[message.handle] = thread;
    }

    writeState(state);
    return { ok: true, processed, replied };
  } finally {
    scanning = false;
  }
}

// Simulate the full pipeline for one message WITHOUT touching chat.db or
// sending anything — for testing before macOS permissions are granted.
async function simulate({ handle = "sim-buyer", text }) {
  const listings = listingStore.listAll().filter((l) => l.title && l.price);
  const state = readState();
  const thread = state.threads[handle] || { listingId: null, lines: [], pendingConfirmation: false };
  let listing = thread.listingId ? listingStore.getById(thread.listingId) : null;
  if (!listing) listing = await matchListing(text, listings);
  if (!listing) return { matched: null, reply: null, note: "not about any active listing — would stay silent" };

  thread.listingId = listing.id;
  thread.lines.push({ role: "buyer", text, at: new Date().toISOString() });
  const reply = await sellerReply(listing, thread, text);
  const outbound = reply.action === "accept" ? PENDING_HOLD_REPLY : reply.text;
  thread.lines.push({ role: "seller", text: outbound, at: new Date().toISOString() });
  if (reply.action === "accept") thread.pendingConfirmation = true;
  state.threads[handle] = thread;
  writeState(state);
  return { matched: { id: listing.id, title: listing.title }, action: reply.action, reply: outbound };
}

function status() {
  const state = readState();
  const threads = Object.entries(state.threads).map(([handle, thread]) => ({
    handle,
    listingId: thread.listingId,
    messages: thread.lines.length,
    pendingConfirmation: !!thread.pendingConfirmation,
    lastLine: thread.lines[thread.lines.length - 1] || null,
  }));
  return {
    enabled: enabled(),
    pollMs: POLL_MS,
    watchingSince: state.lastSeenApple ? appleToIso(state.lastSeenApple) : null,
    threads,
    pendingConfirmations: threads.filter((t) => t.pendingConfirmation).map((t) => t.handle),
  };
}

let timer = null;

function start() {
  if (timer || process.platform !== "darwin") return;
  if (!enabled()) {
    console.log("[sellerInbox] SELLER_IMESSAGE_AUTOREPLY not set — seller iMessage auto-replies off");
    return;
  }
  timer = setInterval(() => {
    scanOnce().catch((err) => console.warn(`[sellerInbox] scan failed: ${err.message}`));
  }, POLL_MS);
  timer.unref?.();
  console.log(`[sellerInbox] watching incoming iMessages every ${POLL_MS / 1000}s`);
  scanOnce().catch((err) => console.warn(`[sellerInbox] first scan failed: ${err.message}`));
}

module.exports = { start, scanOnce, simulate, status };
