// lib/extensionBridge.js
//
// The half of the Facebook Marketplace integration that lives on the
// server: a small job queue the Ampy Chrome extension long-polls.
//
// WHY AN EXTENSION AND NOT A SCRAPER
// ----------------------------------
// Facebook has no buyer-side Marketplace API — the Commerce APIs are
// seller/catalog-side and partner-gated, so there is no "proper" endpoint
// being avoided here. The alternative would be server-side scraping with a
// stored Facebook login, which means handling someone's credentials,
// defeating a login wall, and getting fingerprinted from a datacenter IP.
// This app already has a live example of how that ends: see the 403 note
// for Craigslist in README.md.
//
// The extension inverts it. Marketplace is read in the user's OWN browser,
// in their OWN already-authenticated session, on pages their account can
// normally see. Ampy never touches a Facebook credential, and the
// requests come from a real browser doing what that browser normally does.
//
// FLOW
//   1. Buyer agent searches -> lib/sources/facebook.js enqueues a job here.
//   2. Extension is long-polling GET /api/extension/jobs -> gets the job.
//   3. Extension opens the Marketplace search in a tab, scrapes the cards,
//      POSTs them to /api/extension/jobs/:id/results.
//   4. resolveJob() settles the promise the adapter is awaiting.
//   5. No extension connected, or nobody answers in time? The job times
//      out, the adapter returns [] plus a warning, and the fan-out in
//      lib/sources/index.js still returns Craigslist results.
//
// Deliberately in-memory: jobs are single-request, live for seconds, and
// mean nothing after a restart. Persisting them would only create stale
// work to replay at boot.

const crypto = require("crypto");

const JOB_TIMEOUT_MS = Number(process.env.FB_EXTENSION_TIMEOUT_MS || 25000);
// How long a poll waits for work before returning empty. Long enough that
// the extension isn't hammering the server, short enough that Chrome
// doesn't consider the request stalled.
const POLL_HOLD_MS = 20000;
// An extension that polled within this window counts as connected.
const CONNECTED_WINDOW_MS = 60000;

const pendingJobs = new Map(); // jobId -> job (claimed or not)
const waitingPollers = [];     // resolvers for long-polls with no work yet

let lastPollAt = 0;
let lastResultAt = 0;

function isConnected() {
  return Date.now() - lastPollAt < CONNECTED_WINDOW_MS;
}

function status() {
  return {
    connected: isConnected(),
    lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null,
    lastResultAt: lastResultAt ? new Date(lastResultAt).toISOString() : null,
    pendingJobs: pendingJobs.size,
    timeoutMs: JOB_TIMEOUT_MS,
  };
}

/**
 * Queue a scrape for the extension and wait for it.
 *
 * @returns {Promise<{ok, listings, error?}>} — resolves either way, never rejects.
 */
function requestSearch({ query, maxPrice, location, limit = 20 }) {
  if (!isConnected()) {
    return Promise.resolve({
      ok: false,
      listings: [],
      error:
        "Facebook Marketplace extension isn't connected. Load the extension from the extension/ " +
        "folder (chrome://extensions > Developer mode > Load unpacked) and make sure you're signed in to Facebook.",
    });
  }

  const job = {
    id: `job_${crypto.randomUUID().slice(0, 12)}`,
    query,
    maxPrice: maxPrice ?? null,
    location: location || null,
    limit,
    createdAt: Date.now(),
  };

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingJobs.delete(job.id);
      resolve(value);
    };

    const timer = setTimeout(() => {
      settle({
        ok: false,
        listings: [],
        error: `the extension didn't return Facebook results within ${JOB_TIMEOUT_MS}ms`,
      });
    }, JOB_TIMEOUT_MS);

    job.settle = settle;
    pendingJobs.set(job.id, job);

    // Hand it straight to a poller that's already waiting, if there is one.
    const poller = waitingPollers.shift();
    if (poller) poller([publicJob(job)]);
  });
}

function publicJob(job) {
  if (job.type === "craigslist_post") {
    return { id: job.id, type: "craigslist_post", draft: job.draft };
  }
  return { id: job.id, type: "search", query: job.query, maxPrice: job.maxPrice, location: job.location, limit: job.limit };
}

// How long a queued Craigslist-post job waits for the extension before
// being dropped. Much longer than search jobs: nothing is awaiting the
// result — the human finishes the posting in their browser.
const POST_JOB_EXPIRY_MS = 5 * 60 * 1000;

/**
 * Queue a "fill the Craigslist posting form" job for the extension.
 * Fire-and-forget: returns immediately with whether an extension is even
 * connected; the extension acks via the normal results endpoint purely
 * for the audit trail.
 */
function queueCraigslistPost(draft) {
  const job = {
    id: `job_${crypto.randomUUID().slice(0, 12)}`,
    type: "craigslist_post",
    draft,
    createdAt: Date.now(),
  };
  job.settle = () => { pendingJobs.delete(job.id); };
  setTimeout(() => pendingJobs.delete(job.id), POST_JOB_EXPIRY_MS).unref?.();
  pendingJobs.set(job.id, job);

  const poller = waitingPollers.shift();
  if (poller) poller([publicJob(job)]);

  return { queued: true, jobId: job.id, extensionConnected: isConnected() };
}

/**
 * Long-poll for work. Returns immediately if a job is queued, otherwise
 * holds the connection open for up to POLL_HOLD_MS.
 */
function pollForJobs() {
  lastPollAt = Date.now();

  const queued = [...pendingJobs.values()].filter((j) => !j.claimed);
  if (queued.length > 0) {
    queued.forEach((j) => { j.claimed = true; });
    return Promise.resolve(queued.map(publicJob));
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const i = waitingPollers.indexOf(handoff);
      if (i !== -1) waitingPollers.splice(i, 1);
      resolve([]);
    }, POLL_HOLD_MS);

    const handoff = (jobs) => {
      clearTimeout(timer);
      jobs.forEach((j) => {
        const stored = pendingJobs.get(j.id);
        if (stored) stored.claimed = true;
      });
      resolve(jobs);
    };

    waitingPollers.push(handoff);
  });
}

/** The extension delivering results (scraped listings, or a post-job ack). */
function resolveJob(jobId, { listings = [], error, status: jobStatus } = {}) {
  lastResultAt = Date.now();
  const job = pendingJobs.get(jobId);
  if (!job) return { ok: false, error: "unknown or already-completed job" };
  if (job.type === "craigslist_post") {
    console.log(`[extensionBridge] craigslist post job ${jobId}: ${error || jobStatus || "acknowledged"}`);
    job.settle();
    return { ok: !error, status: jobStatus || "acknowledged" };
  }
  job.settle({ ok: !error, listings, error });
  return { ok: true, accepted: listings.length };
}

module.exports = { requestSearch, queueCraigslistPost, pollForJobs, resolveJob, isConnected, status, JOB_TIMEOUT_MS };
