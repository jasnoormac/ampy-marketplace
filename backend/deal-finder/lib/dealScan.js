// Streams the live-first deal-finding pipeline described in docs/contracts.md.
const fs = require("fs/promises");
const path = require("path");

const { searchCraigslist, fetchListingDetail } = require("./craigslistFetcher");
const { mapWithConcurrency } = require("./concurrency");
const { valueListing } = require("./valuation");
const { getDemand } = require("./demand");
const { scoreDeal } = require("./dealScore");
const { explainDeal } = require("./explain");
const mockListings = require("../data/mockListings");

const LAST_SCAN_PATH = path.join(__dirname, "..", "data", "lastScan.json");
const LIVE_LISTING_LIMIT = 60;
const VALUATION_LIMIT = Number(process.env.VALUATION_LIMIT || 25);
// Pre-filter already keeps only under-median listings, so every candidate has
// positive margin and almost nothing lands below 50. 60 gives a real deal/pass
// split (17/8 on a live sfbay bikes run).
const PASS_THRESHOLD = Number(process.env.PASS_THRESHOLD || 60);
const REPLAY_DELAY_MS = 300;
const US_MARKETS = [
  { slug: "newyork", name: "New York" },
  { slug: "losangeles", name: "Los Angeles" },
  { slug: "chicago", name: "Chicago" },
  { slug: "sfbay", name: "San Francisco Bay Area" },
  { slug: "dallas", name: "Dallas / Fort Worth" },
  { slug: "houston", name: "Houston" },
  { slug: "miami", name: "Miami" },
  { slug: "atlanta", name: "Atlanta" },
  { slug: "seattle", name: "Seattle" },
  { slug: "boston", name: "Boston" },
  { slug: "denver", name: "Denver" },
  { slug: "phoenix", name: "Phoenix" },
];
const US_MARKET_LIMIT = Math.max(1, Math.min(
  US_MARKETS.length,
  Number(process.env.US_MARKET_LIMIT || US_MARKETS.length)
));

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function canonicalListing(listing) {
  const condition = ["new", "like new", "excellent", "good", "fair"].includes(
    String(listing.condition || "").toLowerCase()
  )
    ? String(listing.condition).toLowerCase()
    : "unknown";
  return {
    id: String(listing.id),
    category: listing.category || "general",
    title: listing.title || "Untitled listing",
    price: Number.isFinite(listing.price) ? listing.price : null,
    condition,
    distanceMiles: Number.isFinite(listing.distanceMiles) ? listing.distanceMiles : null,
    location: listing.location || "",
    market: listing.market || "",
    postedAt: listing.postedAt || null,
    sellerName: null,
    sellerRating: null,
    description: listing.description || listing.title || "",
    url: listing.url || "",
    imageUrl: listing.imageUrl || null,
    source: listing.source === "mock" ? "mock" : "craigslist",
  };
}

function mergeDetail(listing, detail) {
  if (!detail) return listing;
  return canonicalListing({
    ...listing,
    imageUrl: detail.imageUrl || listing.imageUrl,
    postedAt: detail.postedAt || listing.postedAt,
    description: detail.description || listing.description,
    condition: detail.condition || listing.condition,
  });
}

function mockResults(maxPrice) {
  const ceiling = Number(maxPrice);
  return mockListings
    .filter((listing) => !Number.isFinite(ceiling) || ceiling <= 0 || listing.price <= ceiling)
    .map(canonicalListing);
}

function extractCraigslistListings(result) {
  if (!result) throw new Error("Craigslist returned no response");
  if (result.error) throw new Error(`Craigslist search failed: ${result.error}`);
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.listings)) return result.listings;
  throw new Error("Craigslist returned an unreadable response");
}

function roundRobinListings(groups, limit = LIVE_LISTING_LIMIT) {
  const output = [];
  const seen = new Set();
  const maxDepth = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < maxDepth && output.length < limit; index += 1) {
    for (const group of groups) {
      const listing = group[index];
      if (!listing || seen.has(listing.id)) continue;
      seen.add(listing.id);
      output.push(listing);
      if (output.length >= limit) break;
    }
  }
  return output;
}

async function searchUnitedStates({ query, category, maxPrice, emit }) {
  const markets = US_MARKETS.slice(0, US_MARKET_LIMIT);
  const results = await mapWithConcurrency(
    markets,
    3,
    async (market) => {
      const result = await searchCraigslist({ location: market.slug, category, query, maxPrice });
      if (!result || result.error) {
        emit("progress", { stage: "market", market: market.name, count: 0, unavailable: true });
        return { market, listings: [], error: result?.error || "no response" };
      }
      const listings = extractCraigslistListings(result).map((listing) => ({
        ...listing,
        market: market.name,
      }));
      emit("progress", { stage: "market", market: market.name, count: listings.length });
      return { market, listings };
    },
    { jitterMs: 180 }
  );
  const available = results.filter((result) => result && !result.error);
  if (!available.length) throw new Error("Craigslist searches failed across all US markets");
  return {
    listings: roundRobinListings(available.map((result) => result.listings)),
    marketsSearched: markets.length,
    marketsAvailable: available.length,
  };
}

function cacheEventsFrom(parsed) {
  let events = [];
  if (Array.isArray(parsed)) {
    events = parsed;
  } else if (parsed && Array.isArray(parsed.events)) {
    events = parsed.events;
  } else if (parsed && Array.isArray(parsed.deals)) {
    events = parsed.deals.map((data) => ({ event: "deal", data }));
  }

  return events
    .map((entry) => {
      if (entry && entry.event && entry.data) return entry;
      if (entry && entry.id) return { event: "deal", data: entry };
      return null;
    })
    .filter((entry) => entry && ["progress", "deal", "pass"].includes(entry.event));
}

async function replayCached(send, startedAt, { fast = false } = {}) {
  const parsed = JSON.parse(await fs.readFile(LAST_SCAN_PATH, "utf8"));
  // Any location is replayable — the cache stores whatever the last scan
  // searched, nationwide or a single market picked in the UI.
  let events = cacheEventsFrom(parsed);

  if (!events.length) throw new Error("No cached deal scan is available");
  if (!events.some(({ event }) => event === "progress")) {
    const deals = events.filter(({ event }) => event === "deal").length;
    events = [
      { event: "progress", data: { stage: "scan", count: deals } },
      { event: "progress", data: { stage: "comps", median: null, n: deals } },
      { event: "progress", data: { stage: "prefilter", candidates: deals } },
      ...events,
    ];
  }

  for (const entry of events) {
    send(entry.event, entry.data);
    if (!fast) await delay(REPLAY_DELAY_MS);
  }

  const deals = events.filter(({ event }) => event === "deal").length;
  const passes = events.filter(({ event }) => event === "pass").length;
  send("done", {
    deals,
    scored: deals + passes,
    ms: Date.now() - startedAt,
    source: "cache",
  });
}

async function persistLiveScan(events, params, summary) {
  const tempPath = `${LAST_SCAN_PATH}.tmp-${process.pid}-${Date.now()}`;
  const contents = JSON.stringify(
    { version: 1, savedAt: new Date().toISOString(), params, events, summary },
    null,
    2
  );

  try {
    await fs.writeFile(tempPath, contents, "utf8");
    await fs.rename(tempPath, LAST_SCAN_PATH);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function runScan(params, send, startedAt) {
  const location = String(params.location || "us");
  const category = String(params.category || "general");
  const query = String(params.query || "").trim();
  const maxPrice = params.maxPrice;
  const forceMock = String(process.env.USE_MOCK_DATA || "").toLowerCase() === "true";
  const recordedEvents = [];
  const emit = (event, data) => {
    send(event, data);
    recordedEvents.push({ event, data });
  };

  let listings;
  let source;

  if (forceMock) {
    listings = mockResults(maxPrice);
    source = "mock";
  } else {
    const result = location === "us"
      ? await searchUnitedStates({ query, category, maxPrice, emit })
      : {
          listings: extractCraigslistListings(
            await searchCraigslist({ location, category, query, maxPrice })
          ),
          marketsSearched: 1,
          marketsAvailable: 1,
        };
    listings = result.listings.slice(0, LIVE_LISTING_LIMIT).map(canonicalListing);
    source = "craigslist";
    emit("progress", {
      stage: "coverage",
      markets: result.marketsSearched,
      available: result.marketsAvailable,
    });
  }

  emit("progress", {
    stage: "scan",
    count: listings.length,
    markets: location === "us" ? US_MARKET_LIMIT : 1,
  });

  const prices = listings
    .map((listing) => listing.price)
    .filter((price) => Number.isFinite(price));
  const compsMedian = median(prices);
  const compsN = prices.length;
  emit("progress", { stage: "comps", median: compsMedian, n: compsN });

  const candidates = (compsMedian === null
    ? []
    : listings.filter(
      (listing) => Number.isFinite(listing.price) && listing.price < compsMedian
    )).slice(0, VALUATION_LIMIT);
  emit("progress", { stage: "prefilter", candidates: candidates.length });

  let deals = 0;
  let scored = 0;

  await mapWithConcurrency(
    candidates,
    2, // Mistral 429s at 4-way; 2 is the sweet spot for demo-tier limits
    async (baseListing) => {
      emit("progress", { stage: "valuing", id: baseListing.id, title: baseListing.title });
      emit("candidate", {
        ...baseListing,
        compsMedian,
        compsN,
      });

      try {
        const detail = source === "craigslist"
          ? await fetchListingDetail(baseListing.url)
          : null;
        const listing = mergeDetail(baseListing, detail);
        emit("analysis", {
          id: listing.id,
          stage: "details",
          listing: {
            description: listing.description,
            condition: listing.condition,
            imageUrl: listing.imageUrl,
            postedAt: listing.postedAt,
          },
        });
        const valuation = await valueListing(listing, {
          compsMedian,
          compsN,
          city: location === "us" ? "the United States" : location,
        });
        emit("analysis", {
          id: listing.id,
          stage: "appraisal",
          valuation,
        });
        emit("analysis", {
          id: listing.id,
          stage: "comps",
          compsMedian,
          compsN,
        });
        const keyword = valuation.brandModel || query;
        const demand = await getDemand({ keyword, category, geo: "US" });
        emit("analysis", {
          id: listing.id,
          stage: "demand",
          demand: {
            value: demand.value,
            source: demand.source,
            keyword: demand.keyword || keyword,
          },
        });
        const scoredDeal = scoreDeal({
          price: listing.price,
          compsMedian,
          compsN,
          mistralEstimate: valuation.estimatedResaleUsd,
          demand: demand.value,
          hasPhoto: Boolean(listing.imageUrl),
          descLen: listing.description.length,
        });

        if (!Number.isFinite(scoredDeal.score)) {
          throw new Error("scorer returned an invalid score");
        }

        emit("analysis", {
          id: listing.id,
          stage: "score",
          fairValue: scoredDeal.fairValue,
          deal: {
            score: scoredDeal.score,
            margin: scoredDeal.margin,
            confidence: scoredDeal.confidence,
            flags: scoredDeal.flags || [],
          },
        });

        const explanation = await explainDeal({ listing, valuation, deal: scoredDeal });
        scored += 1;

        const scoredPayload = {
          ...listing,
          valuation,
          compsMedian,
          compsN,
          fairValue: scoredDeal.fairValue,
          demand: {
            value: demand.value,
            source: demand.source,
            keyword: demand.keyword || keyword,
          },
          deal: {
            score: scoredDeal.score,
            margin: scoredDeal.margin,
            confidence: scoredDeal.confidence,
            flags: scoredDeal.flags || [],
            headline: explanation.headline,
            why: explanation.why,
            riskNote: explanation.riskNote,
            explanationProvenance: explanation.provenance,
          },
        };

        if (scoredDeal.score < PASS_THRESHOLD) {
          const flags = scoredDeal.flags && scoredDeal.flags.length
            ? `; flags: ${scoredDeal.flags.join(", ")}`
            : "";
          emit("pass", {
            ...scoredPayload,
            reason: `Score ${Math.round(scoredDeal.score)}/100${flags}`,
          });
          return;
        }

        deals += 1;
        emit("analysis", {
          id: listing.id,
          stage: "verdict",
          outcome: "deal",
          headline: explanation.headline,
          score: scoredDeal.score,
        });
        emit("deal", scoredPayload);
      } catch (error) {
        scored += 1;
        emit("analysis", {
          id: baseListing.id,
          stage: "error",
          message: error.message,
        });
        emit("pass", {
          id: baseListing.id,
          title: baseListing.title,
          price: baseListing.price,
          reason: `Unable to score: ${error.message}`,
        });
      }
    },
    { jitterMs: 250 }
  );

  const elapsed = Date.now() - startedAt;
  if (source === "craigslist" && listings.length > 0) {
    try {
      await persistLiveScan(
        recordedEvents,
        { location, category, query, maxPrice: maxPrice || null },
        { deals, scored, ms: elapsed, source }
      );
    } catch (error) {
      console.warn(`[dealScan] could not persist live scan: ${error.message}`);
    }
  }

  send("done", { deals, scored, ms: Date.now() - startedAt, source });
}

const FAST_MARKET_LIMIT = 4;
const FAST_DETAIL_LIMIT = 12;

function compsScore(listing, compsMedian, compsN) {
  const price = listing.price;
  const fairValue = compsMedian;
  const discount = fairValue > 0 ? (fairValue - price) / fairValue : 0;
  const score = Math.max(0, Math.min(100, Math.round(50 + discount * 80 + Math.min(compsN, 8))));
  return { fairValue, score, margin: discount };
}

async function runFastScrapeScan(params, send, startedAt) {
  const location = String(params.location || "us").toLowerCase();
  const category = String(params.category || "general");
  const query = String(params.query || "").trim();
  const maxPrice = params.maxPrice;
  const emit = (event, data) => send(event, data);

  let listings;
  let source = "craigslist";
  let marketsSearched = 1;

  if (location === "us") {
    const markets = US_MARKETS.slice(0, FAST_MARKET_LIMIT);
    const results = await mapWithConcurrency(
      markets,
      3,
      async (market) => {
        const result = await searchCraigslist({ location: market.slug, category, query, maxPrice });
        if (!result || result.error) {
          emit("progress", { stage: "market", market: market.name, count: 0, unavailable: true });
          return { listings: [], error: result?.error || "no response" };
        }
        const found = extractCraigslistListings(result).map((listing) => ({
          ...listing,
          market: market.name,
        }));
        emit("progress", { stage: "market", market: market.name, count: found.length });
        return { listings: found };
      },
      { jitterMs: 120 },
    );
    const available = results.filter((result) => result && !result.error);
    if (!available.length) throw new Error("Craigslist searches failed across all US markets");
    listings = roundRobinListings(available.map((result) => result.listings));
    marketsSearched = markets.length;
  } else {
    listings = extractCraigslistListings(
      await searchCraigslist({ location, category, query, maxPrice }),
    );
  }

  listings = listings.slice(0, LIVE_LISTING_LIMIT).map(canonicalListing);
  emit("progress", { stage: "scan", count: listings.length, markets: marketsSearched, mode: "scrape" });

  const prices = listings.map((listing) => listing.price).filter((price) => Number.isFinite(price));
  const compsMedian = median(prices);
  const compsN = prices.length;
  emit("progress", { stage: "comps", median: compsMedian, n: compsN });

  const priced = listings.filter((listing) => Number.isFinite(listing.price));
  const underMarket = compsMedian == null
    ? priced
    : priced.filter((listing) => listing.price < compsMedian);
  const pool = (underMarket.length ? underMarket : priced)
    .slice()
    .sort((a, b) => a.price - b.price)
    .slice(0, FAST_DETAIL_LIMIT);
  emit("progress", { stage: "prefilter", candidates: pool.length });

  const detailed = await mapWithConcurrency(
    pool,
    3,
    async (baseListing) => {
      const detail = await fetchListingDetail(baseListing.url);
      return mergeDetail(baseListing, detail);
    },
    { jitterMs: 120 },
  );

  let deals = 0;
  for (const listing of detailed.filter(Boolean)) {
    const scored = compsScore(listing, compsMedian || listing.price, compsN);
    const discountPct = scored.fairValue
      ? Math.max(0, Math.round((1 - listing.price / scored.fairValue) * 100))
      : 0;
    emit("deal", {
      ...listing,
      compsMedian,
      compsN,
      fairValue: scored.fairValue,
      deal: {
        score: scored.score,
        margin: scored.margin,
        confidence: Math.min(compsN / 8, 1),
        flags: [],
        headline: discountPct ? `${discountPct}% under this search's median` : "Live Craigslist listing",
        why: compsMedian
          ? `Asking $${listing.price} vs median $${Math.round(compsMedian)} across ${compsN} scraped listings.`
          : "Scraped from Craigslist; not enough priced comps for a median yet.",
      },
    });
    deals += 1;
  }

  send("done", {
    deals,
    scored: deals,
    ms: Date.now() - startedAt,
    source,
    mode: "scrape",
  });
}

async function streamDeals(params = {}, send) {
  if (typeof send !== "function") throw new TypeError("send must be a function");
  const startedAt = Date.now();

  try {
    if (String(params.cached || "") === "1") {
      // fast=1: dump the cache instantly (page load); otherwise replay with pacing
      await replayCached(send, startedAt, { fast: String(params.fast || "") === "1" });
      return;
    }
    if (String(params.fast || "") === "1") {
      // Chat/UI path: scrape Craigslist and return underpriced listings
      // without waiting on per-listing Mistral appraisals (those 429 on demo keys).
      await runFastScrapeScan(params, send, startedAt);
      return;
    }
    await runScan(params, send, startedAt);
  } catch (error) {
    send("error", { message: error.message });
  }
}

module.exports = { streamDeals, extractCraigslistListings, roundRobinListings };
