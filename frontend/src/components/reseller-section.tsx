"use client";

import * as React from "react";
import { ExternalLink, Radar, RotateCcw, Search, TerminalSquare, X } from "lucide-react";

import {
  DEAL_CATEGORIES,
  clamp,
  demandSourceLabel,
  listingPlace,
  money,
  optionalNumber,
  postedAgo,
  safeText,
  safeUrl,
  scoreTone,
  type DealListing,
  type LogLine,
  type TraceLine,
} from "@/lib/dealFinder";
import { ampyApi } from "@/lib/ampy";
import { cn, titleCaseLocation } from "@/lib/utils";

interface CraigslistLocation {
  region: string;
  state: string;
  slug: string;
  name: string;
}

/**
 * Reseller = the Deal Finder. A port of deal-finder/public/app.js from the
 * `deal-finder-nationwide` branch onto the Ampy UI: same SSE contract, same
 * card/pass/trace logic, same backend (backend/deal-finder on :4747 via the
 * /api/deals rewrite). Only the rendering changed.
 */

type EventName = "progress" | "candidate" | "analysis" | "deal" | "pass" | "done" | "error";
const EVENT_NAMES: EventName[] = ["progress", "candidate", "analysis", "deal", "pass", "done", "error"];

interface ScanState {
  deals: DealListing[];
  candidates: DealListing[];
  passes: DealListing[];
  traces: Record<string, TraceLine[]>;
  log: LogLine[];
  scanning: boolean;
  loadingCache: boolean;
  banner: string | null;
  source: string | null;
  listingCount: number | null;
  currentQuery: string;
  emptyQuery: string | null;
  showEmpty: boolean;
  showSkeleton: boolean;
  flipped: Record<string, boolean>;
}

type Action =
  | { type: "reset"; query: string }
  | { type: "log"; line: Omit<LogLine, "id"> }
  | { type: "listingCount"; count: number }
  | { type: "candidate"; listing: DealListing }
  | { type: "analysis"; id: string; details?: Partial<DealListing>; line: TraceLine }
  | { type: "deal"; listing: DealListing; silent: boolean }
  | { type: "pass"; pass: DealListing }
  | { type: "done"; source: string | null; silent: boolean }
  | { type: "fatal"; silent: boolean }
  | { type: "scanning"; scanning: boolean }
  | { type: "banner"; message: string | null }
  | { type: "flip"; id: string; flipped: boolean }
  | { type: "loadingCache"; loading: boolean };

const INITIAL: ScanState = {
  deals: [],
  candidates: [],
  passes: [],
  traces: {},
  log: [],
  scanning: false,
  loadingCache: false,
  banner: null,
  source: null,
  listingCount: null,
  currentQuery: "",
  emptyQuery: null,
  showEmpty: true,
  showSkeleton: false,
  flipped: {},
};

let logId = 0;

function completedTrace(listing: DealListing): TraceLine[] {
  const score = Math.round(clamp(listing.deal?.score, 0, 100));
  const delta = Number(listing.fairValue) - Number(listing.price);
  const demand = clamp(listing.demand?.value, 0, 1);
  return [
    { label: "DISCOVERED", message: `${money(listing.price)} ask · listing captured from ${safeText(listing.source, "source")}`, tone: "info" },
    { label: "MISTRAL", message: `${safeText(listing.valuation?.brandModel, listing.valuation?.item || "item")} · blind appraisal ${money(listing.valuation?.estimatedResaleUsd)}`, tone: "info" },
    { label: "COMPS", message: `${money(listing.compsMedian)} Craigslist asking median · n=${safeText(listing.compsN, 0)}`, tone: "info" },
    { label: "DEMAND", message: `${Math.round(demand * 100)}% proxy via ${safeText(listing.demand?.source, "baseline")}`, tone: "info" },
    { label: "RESULT", message: `surfaced at ${score}/100 · ${money(delta)} estimated upside`, tone: "success" },
  ];
}

function reducer(state: ScanState, action: Action): ScanState {
  switch (action.type) {
    case "reset":
      return { ...INITIAL, currentQuery: action.query, showEmpty: false, showSkeleton: true, banner: null };
    case "log":
      return { ...state, log: [...state.log.slice(-199), { id: ++logId, ...action.line }] };
    case "listingCount":
      return { ...state, listingCount: action.count };
    case "candidate": {
      const id = action.listing.id;
      if (state.candidates.some((item) => item.id === id) || state.deals.some((item) => item.id === id)) return state;
      return {
        ...state,
        candidates: [...state.candidates, action.listing],
        traces: { ...state.traces, [id]: [{ label: "DISCOVERED", message: `${money(action.listing.price)} ask · below ${money(action.listing.compsMedian)} search median`, tone: "info" }] },
        flipped: { ...state.flipped, [id]: true },
        showSkeleton: false,
        showEmpty: false,
      };
    }
    case "analysis": {
      if (!state.candidates.some((item) => item.id === action.id)) return state;
      return {
        ...state,
        candidates: action.details
          ? state.candidates.map((item) => (item.id === action.id ? { ...item, ...action.details } : item))
          : state.candidates,
        traces: { ...state.traces, [action.id]: [...(state.traces[action.id] || []), action.line] },
      };
    }
    case "deal": {
      const { listing } = action;
      const wasLive = state.candidates.some((item) => item.id === listing.id);
      const deals = [...state.deals.filter((item) => item.id !== listing.id), listing].sort((a, b) => Number(b.deal?.score) - Number(a.deal?.score));
      const trace = wasLive
        ? [...(state.traces[listing.id] || []), { label: "RESULT", message: `DEAL SURFACED · ${Math.round(clamp(listing.deal?.score, 0, 100))}/100 · ${money(Number(listing.fairValue) - Number(listing.price))} estimated upside`, tone: "success" as const }]
        : completedTrace(listing);
      return {
        ...state,
        deals,
        candidates: state.candidates.filter((item) => item.id !== listing.id),
        traces: { ...state.traces, [listing.id]: trace },
        flipped: { ...state.flipped, [listing.id]: wasLive ? true : false },
        showSkeleton: false,
        showEmpty: false,
      };
    }
    case "pass": {
      const { pass } = action;
      const wasLive = state.candidates.some((item) => item.id === pass.id);
      return {
        ...state,
        candidates: state.candidates.filter((item) => item.id !== pass.id),
        passes: [...state.passes, pass],
        traces: wasLive
          ? { ...state.traces, [pass.id]: [...(state.traces[pass.id] || []), { label: "RESULT", message: `PASS · ${safeText(pass.reason, "did not meet the deal threshold")}`, tone: "error" }] }
          : state.traces,
      };
    }
    case "done": {
      const noDeals = state.deals.length === 0;
      return {
        ...state,
        source: action.source,
        loadingCache: false,
        scanning: action.silent ? state.scanning : false,
        showSkeleton: false,
        showEmpty: noDeals,
        emptyQuery: noDeals && action.source === "craigslist" && state.listingCount === 0 ? state.currentQuery : null,
      };
    }
    case "fatal":
      if (action.silent) return { ...INITIAL, log: state.log, banner: state.banner };
      return { ...state, scanning: false, loadingCache: false, showSkeleton: false, showEmpty: state.deals.length === 0 };
    case "scanning":
      return { ...state, scanning: action.scanning };
    case "banner":
      return { ...state, banner: action.message };
    case "flip":
      return { ...state, flipped: { ...state.flipped, [action.id]: action.flipped } };
    case "loadingCache":
      return { ...state, loadingCache: action.loading };
    default:
      return state;
  }
}

interface DrawerState {
  mode: "product" | "trace";
  listing: DealListing;
  isPass: boolean;
}

export function ResellerSection(): React.ReactElement {
  const [state, dispatch] = React.useReducer(reducer, INITIAL);
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const [category, setCategory] = React.useState("general");
  const [location, setLocation] = React.useState("us");
  const [locations, setLocations] = React.useState<CraigslistLocation[]>([]);
  const [query, setQuery] = React.useState("");
  const [maxPrice, setMaxPrice] = React.useState("400");
  const [showPasses, setShowPasses] = React.useState(false);
  // Quick scan = backend fast path (4 markets, comps-only scoring, seconds).
  // Deep scan = full 12-market run with per-listing Mistral appraisal (minutes).
  const [deep, setDeep] = React.useState(false);
  const [drawer, setDrawer] = React.useState<DrawerState | null>(null);
  const sourceRef = React.useRef<EventSource | null>(null);
  const queryInputRef = React.useRef<HTMLInputElement>(null);

  const log = React.useCallback((message: string, type: LogLine["type"] = "progress", mark = "›") => {
    dispatch({ type: "log", line: { type, mark, message } });
  }, []);

  const closeStream = React.useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  const handleEvent = React.useCallback((event: EventName, data: Record<string, unknown>, silentCache: boolean) => {
    const current = stateRef.current;
    if (event === "progress") {
      if (silentCache) return;
      if (data.stage === "scan") dispatch({ type: "listingCount", count: Number(data.count) || 0 });
      const messages: Record<string, () => string> = {
        market: () => `${safeText(data.market, "U.S. market")} · ${data.unavailable ? "unavailable" : `${safeText(data.count, 0)} listings found`}`,
        coverage: () => `U.S. coverage · ${safeText(data.available, 0)} of ${safeText(data.markets, 0)} priority markets available`,
        scan: () => `scanned ${safeText(data.count, 0)} listings across ${safeText(data.markets, 1)} U.S. markets`,
        comps: () => `market comps · median ${money(data.median)} across n=${safeText(data.n, 0)}`,
        prefilter: () => `pre-filter retained ${safeText(data.candidates, 0)} candidates below median`,
        valuing: () => `Mistral evaluating “${safeText(data.title, (data.id as string) || "listing")}”`,
      };
      const stage = String(data.stage || "");
      log(messages[stage] ? messages[stage]() : `${safeText(stage, "working")} · agent processing`, "progress", "▸");
      return;
    }
    if (event === "candidate") {
      if (silentCache || typeof data.id !== "string") return;
      dispatch({ type: "candidate", listing: data as unknown as DealListing });
      return;
    }
    if (event === "analysis") {
      if (silentCache || typeof data.id !== "string") return;
      const id = data.id;
      const stage = String(data.stage || "");
      const candidate = current.candidates.find((item) => item.id === id);
      if (!candidate) return;
      const details = stage === "details" ? ((data.listing as Partial<DealListing>) || {}) : undefined;
      const merged = { ...candidate, ...(details || {}) };
      const valuation = (data.valuation || {}) as DealListing["valuation"];
      const demand = (data.demand || {}) as NonNullable<DealListing["demand"]>;
      const deal = (data.deal || {}) as NonNullable<DealListing["deal"]>;
      const messages: Record<string, () => string> = {
        details: () => `${merged.imageUrl ? "photo + " : ""}listing details fetched · condition ${safeText(merged.condition, "unknown")}`,
        appraisal: () => `Mistral identified ${safeText(valuation?.brandModel, valuation?.item || "item")} · ${safeText(valuation?.condition, "unknown")} · blind appraisal ${money(valuation?.estimatedResaleUsd)}`,
        comps: () => `${money(data.compsMedian)} Craigslist asking median · n=${safeText(data.compsN, 0)}`,
        demand: () => `${safeText(demand.keyword, "category")} · ${Math.round(clamp(demand.value, 0, 1) * 100)}% proxy via ${safeText(demand.source, "baseline")}`,
        score: () => `${Math.round(clamp(deal.score, 0, 100))}/100 · fair value ${money(data.fairValue)} · ${Math.round(clamp(deal.confidence, 0, 1) * 100)}% confidence`,
        verdict: () => `${safeText(data.headline, "Deal threshold met")} · score ${Math.round(clamp(data.score, 0, 100))}`,
        error: () => safeText(data.message, "Candidate could not be scored"),
      };
      const labels: Record<string, string> = { details: "DETAILS", appraisal: "MISTRAL", comps: "COMPS", demand: "DEMAND", score: "SCORE", verdict: "VERDICT", error: "ERROR" };
      dispatch({
        type: "analysis",
        id,
        details,
        line: { label: labels[stage] || "EVIDENCE", message: messages[stage] ? messages[stage]() : safeText(stage, "updated"), tone: stage === "error" ? "error" : stage === "verdict" ? "success" : "info" },
      });
      return;
    }
    if (event === "deal") {
      const listing = data as unknown as DealListing;
      if (!listing.id || !listing.deal) return;
      const wasLive = current.candidates.some((item) => item.id === listing.id);
      dispatch({ type: "deal", listing, silent: silentCache });
      if (wasLive) {
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.setTimeout(() => dispatch({ type: "flip", id: listing.id, flipped: false }), reduced ? 0 : 520);
      }
      if (!silentCache) {
        const score = Math.round(clamp(listing.deal.score, 0, 100));
        const delta = Number(listing.fairValue) - Number(listing.price);
        const flagged = Array.isArray(listing.deal.flags) && listing.deal.flags.includes("too_good");
        log(flagged ? `flagged “${listing.title}” · implausible price / too good` : `score ${score} · “${listing.title}” · ${money(delta)} upside`, flagged ? "pass" : "deal", flagged ? "!" : "✓");
      }
      return;
    }
    if (event === "pass") {
      const pass = data as unknown as DealListing;
      if (!pass.id) return;
      dispatch({ type: "pass", pass });
      if (!silentCache) log(`passed “${safeText(pass.title)}” · ${safeText(pass.reason, "below threshold")}`, "pass", "×");
      return;
    }
    if (event === "done") {
      closeStream();
      const source = typeof data.source === "string" ? data.source : null;
      dispatch({ type: "done", source, silent: silentCache });
      if (silentCache) {
        log("loaded last real scan", "progress", "■");
        dispatch({ type: "banner", message: "Showing last real scan · press Find deals for live" });
        return;
      }
      log(`scan complete · ${safeText(data.deals, current.deals.length)} surfaced / ${safeText(data.scored, current.deals.length + current.passes.length)} scored`, "progress", "■");
      if (source === "cache") dispatch({ type: "banner", message: "Showing last real scan · press Find deals for live" });
      else if (source === "mock") dispatch({ type: "banner", message: "Craigslist unavailable — showing representative fallback listings." });
      return;
    }
    if (event === "error") {
      closeStream();
      dispatch({ type: "fatal", silent: silentCache });
      if (silentCache) return;
      const message = safeText(data.message, "The scan could not be completed.");
      log(message, "error", "!");
      dispatch({ type: "banner", message: `${message} Try Last scan to keep the demo moving.` });
    }
  }, [closeStream, log]);

  // Craigslist market list for the location dropdown — static server-side
  // data, fetched once. On failure the dropdown just offers nationwide.
  React.useEffect(() => {
    let cancelled = false;
    fetch(ampyApi.dealFinder.locations)
      .then((response) => (response.ok ? response.json() : []))
      .then((data: unknown) => {
        if (!cancelled && Array.isArray(data)) {
          setLocations((data as CraigslistLocation[]).filter((item) => item.region === "US" && item.slug && item.state));
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const marketsByState = React.useMemo(() => {
    const groups = new Map<string, CraigslistLocation[]>();
    for (const item of locations) {
      const group = groups.get(item.state) ?? [];
      group.push(item);
      groups.set(item.state, group);
    }
    return Array.from(groups.entries());
  }, [locations]);

  const connect = React.useCallback((params: URLSearchParams, silentCache: boolean) => {
    closeStream();
    const source = new EventSource(`${ampyApi.dealFinder.deals}?${params.toString()}`);
    sourceRef.current = source;
    for (const name of EVENT_NAMES) {
      source.addEventListener(name, (event) => {
        if (sourceRef.current !== source) return;
        const raw = (event as MessageEvent).data;
        if (!raw) return;
        try {
          handleEvent(name, JSON.parse(raw) as Record<string, unknown>, silentCache);
        } catch {
          if (name === "error") handleEvent("error", { message: "The scan ended with an unreadable error." }, silentCache);
        }
      });
    }
    source.onerror = () => {
      if (sourceRef.current !== source) return;
      if (!stateRef.current.scanning && !stateRef.current.loadingCache) return;
      handleEvent("error", { message: "The live stream disconnected before the scan completed." }, silentCache);
    };
  }, [closeStream, handleEvent]);

  const startScan = React.useCallback((cached = false) => {
    const target = query.trim();
    if (!target) {
      queryInputRef.current?.focus();
      return;
    }
    setDrawer(null);
    dispatch({ type: "reset", query: target });
    dispatch({ type: "scanning", scanning: true });
    const locationLabel = location === "us" ? "United States" : titleCaseLocation(locations.find((item) => item.slug === location)?.name ?? location);
    log(`scan initialized · ${locationLabel} / ${category} / “${target}” · ${deep ? "deep scan (Mistral appraisal)" : "quick scan"}`, "progress", "▸");
    const params = new URLSearchParams({ location, category, query: target, maxPrice: maxPrice || "400" });
    if (!deep) params.set("fast", "1");
    if (cached) {
      params.set("cached", "1");
      dispatch({ type: "banner", message: "Showing last real scan · press Find deals for live" });
    }
    connect(params, false);
  }, [category, connect, deep, location, locations, log, maxPrice, query]);

  // Start clean; the last real scan is one click away via "Last scan".
  React.useEffect(() => closeStream, [closeStream]);

  React.useEffect(() => {
    if (!drawer) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setDrawer(null); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [drawer]);

  const dealWord = state.deals.length === 1 ? "deal" : "deals";
  const resultCount = `${state.deals.length} ${dealWord}${state.candidates.length ? ` · ${state.candidates.length} analyzing` : ""}${state.passes.length ? ` · ${state.passes.length} passed` : ""}`;

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6" aria-labelledby="reseller-heading">
      <header className="text-center">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.28em] text-sky-300">U.S. marketplace intelligence</p>
        <h2 id="reseller-heading" className="text-balance text-3xl font-semibold tracking-tight sm:text-5xl">Find the deal before everyone else.</h2>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-white/55 sm:text-base">
          Search a niche across the country, compare fair value, and see exactly why each opportunity made the cut.
        </p>
      </header>

      <form
        onSubmit={(event) => { event.preventDefault(); startScan(); }}
        className="grid gap-2 rounded-3xl border border-white/10 bg-[#141418] p-3 shadow-[0_18px_70px_rgba(0,0,0,0.42)] md:grid-cols-[1.1fr_0.9fr_1.7fr_0.7fr_auto]"
        aria-label="Scan settings"
      >
        <label className="flex h-12 items-center gap-2 rounded-2xl bg-sky-500/15 px-4 text-sm">
          <Radar className="size-4 shrink-0 text-sky-300" />
          <span className="sr-only">Market location</span>
          <select value={location} onChange={(event) => setLocation(event.target.value)} className="w-full bg-transparent font-semibold text-white outline-none">
            <option value="us" className="bg-[#141418]">United States · 12 markets</option>
            {marketsByState.map(([state, markets]) => (
              <optgroup key={state} label={state} className="bg-[#141418]">
                {markets.map((item) => <option key={item.slug} value={item.slug} className="bg-[#141418]">{titleCaseLocation(item.name)}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="flex h-12 items-center rounded-2xl bg-black/30 px-3 text-sm">
          <span className="sr-only">Listing category</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)} className="w-full bg-transparent text-white outline-none">
            {DEAL_CATEGORIES.map((item) => <option key={item.value} value={item.value} className="bg-[#141418]">{item.label}</option>)}
          </select>
        </label>
        <label className="flex h-12 items-center gap-2 rounded-2xl bg-black/30 px-3 text-sm focus-within:ring-1 focus-within:ring-sky-400/60">
          <Search className="size-4 text-white/40" />
          <span className="sr-only">Search target</span>
          <input ref={queryInputRef} value={query} onChange={(event) => setQuery(event.target.value)} type="search" placeholder="What should the agent find? e.g. road bike, espresso machine" required className="w-full bg-transparent text-white outline-none placeholder:text-white/30" />
        </label>
        <label className="flex h-12 items-center gap-1 rounded-2xl bg-black/30 px-3 text-sm focus-within:ring-1 focus-within:ring-sky-400/60">
          <span className="text-white/40">$</span>
          <span className="sr-only">Maximum price in dollars</span>
          <input value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} type="number" min={1} step={1} inputMode="numeric" className="w-full bg-transparent text-white outline-none" />
        </label>
        <div className="grid gap-1">
          <button type="submit" disabled={state.scanning} className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-sky-500 px-5 text-sm font-semibold text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-60">
            {state.scanning ? "Searching…" : "Find deals"}
          </button>
          <button type="button" onClick={() => startScan(true)} disabled={state.scanning} title="Replay the last successful scan" className="inline-flex h-8 items-center justify-center gap-1 rounded-xl text-xs text-white/55 hover:text-white disabled:opacity-50">
            Last scan <RotateCcw className="size-3" />
          </button>
        </div>
        <label className="flex items-center gap-2 px-1 text-xs text-white/55 md:col-span-5">
          <input type="checkbox" checked={deep} onChange={(event) => setDeep(event.target.checked)} disabled={state.scanning} className="accent-sky-400" />
          Deep scan — all 12 markets with per-listing Mistral appraisal (slow). Off = quick scrape scored against market comps.
        </label>
      </form>

      {state.banner ? (
        <div role="status" className="flex items-center gap-3 rounded-2xl border border-amber-400/20 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-100">
          <span className="font-mono text-amber-300">!</span>
          <span className="flex-1">{state.banner}</span>
          <button type="button" onClick={() => dispatch({ type: "banner", message: null })} aria-label="Dismiss notification" className="text-amber-200/70 hover:text-white"><X className="size-4" /></button>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)]">
        <AgentPanel log={state.log} scanning={state.scanning} />

        <section className="flex flex-col gap-3 rounded-3xl border border-white/10 bg-white/5 p-4" aria-labelledby="feed-title">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-sky-300">Ranked opportunities</p>
              <div className="flex items-baseline gap-2">
                <h3 id="feed-title" className="text-lg font-semibold">Deals worth a closer look</h3>
                <span className="text-xs text-white/45" data-testid="result-count">{resultCount}</span>
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs text-white/60">
              <input type="checkbox" data-testid="show-passes" checked={showPasses} onChange={(event) => setShowPasses(event.target.checked)} className="accent-sky-400" />
              Show passes
            </label>
          </div>

          {state.showEmpty && !state.deals.length && !state.candidates.length ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-white/10 px-6 py-10 text-center">
              <Radar className="size-8 animate-pulse text-sky-300/70" />
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-sky-300">{state.emptyQuery ? "No matching listings" : "Ready when you are"}</p>
              <p className="text-base font-semibold">{state.emptyQuery ? "Nothing found this time." : "Promising finds will land here."}</p>
              <p className="max-w-md text-xs leading-5 text-white/50">
                {state.emptyQuery
                  ? `Craigslist returned no listings for “${state.emptyQuery}” across the current U.S. coverage and category. Try All categories, a broader phrase, or a higher budget.`
                  : "We compare the ask, condition, market comps, and resale demand as listings arrive across the U.S."}
              </p>
            </div>
          ) : null}

          {state.showSkeleton && !state.deals.length && !state.candidates.length ? (
            <div className="grid gap-3" aria-label="Scanning for deals">
              {[0, 1, 2].map((index) => (
                <div key={index} className="flex animate-pulse gap-3 rounded-2xl border border-white/10 bg-black/20 p-3">
                  <div className="size-20 rounded-xl bg-white/10" />
                  <div className="flex-1 space-y-2 py-1"><div className="h-3 w-2/3 rounded bg-white/10" /><div className="h-2.5 w-1/2 rounded bg-white/10" /><div className="h-2.5 w-1/3 rounded bg-white/10" /></div>
                  <div className="size-12 rounded-full bg-white/10" />
                </div>
              ))}
            </div>
          ) : null}

          <div className="grid gap-3" aria-live="polite">
            {state.deals.map((listing, index) => (
              <DealCard
                key={listing.id}
                listing={listing}
                rank={index + 1}
                trace={state.traces[listing.id] || []}
                flipped={Boolean(state.flipped[listing.id])}
                analyzing={false}
                onFlip={(flipped) => dispatch({ type: "flip", id: listing.id, flipped })}
                onOpenProduct={() => setDrawer({ mode: "product", listing, isPass: false })}
                onOpenTrace={() => setDrawer({ mode: "trace", listing, isPass: false })}
              />
            ))}
            {state.candidates.map((listing) => (
              <DealCard
                key={listing.id}
                listing={listing}
                rank={null}
                trace={state.traces[listing.id] || []}
                flipped
                analyzing
                onFlip={() => undefined}
                onOpenProduct={() => undefined}
                onOpenTrace={() => undefined}
              />
            ))}
          </div>

          {showPasses && state.passes.length ? (
            <div className="grid gap-2" data-testid="pass-list">
              {state.passes.map((pass) => (
                <button
                  key={pass.id}
                  type="button"
                  onClick={() => setDrawer({ mode: "trace", listing: pass, isPass: true })}
                  className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-left hover:border-white/25"
                  aria-label={`${safeText(pass.title, "Untitled listing")}, passed. View decision trace.`}
                >
                  <span className="rounded-full bg-white/10 px-2 py-0.5 font-mono text-[10px] text-white/60">PASS</span>
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-sm text-white/85">{safeText(pass.title, "Untitled listing")}</strong>
                    <small className="block truncate text-xs text-white/45">{safeText(pass.reason, "Did not meet the deal threshold.")}</small>
                  </span>
                  <span className="text-sm font-semibold text-white/70">{money(pass.price)}</span>
                  <span className="hidden font-mono text-[10px] uppercase tracking-[0.12em] text-sky-300 sm:inline">View decision trace ↗</span>
                </button>
              ))}
            </div>
          ) : null}
        </section>
      </div>

      {drawer ? (
        <Drawer
          drawer={drawer}
          rankIndex={drawer.isPass ? state.passes.findIndex((item) => item.id === drawer.listing.id) : state.deals.findIndex((item) => item.id === drawer.listing.id)}
          onClose={() => setDrawer(null)}
          onOpenTrace={() => setDrawer({ ...drawer, mode: "trace" })}
        />
      ) : null}
    </section>
  );
}

// --- Agent panel -------------------------------------------------------------

function AgentPanel({ log, scanning }: { log: LogLine[]; scanning: boolean }): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [log]);
  const tone: Record<LogLine["type"], string> = { progress: "text-white/65", deal: "text-emerald-300", pass: "text-white/40", error: "text-red-300" };
  return (
    <section className="flex min-h-[320px] flex-col rounded-3xl border border-white/10 bg-[#0c0c10] p-4" aria-labelledby="console-title">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-sky-300">Live execution</p>
          <h3 id="console-title" className="text-lg font-semibold">Finder activity</h3>
        </div>
        <span className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em]", scanning ? "border-emerald-400/40 text-emerald-300" : "border-white/10 text-white/40")}>
          <span className={cn("size-1.5 rounded-full", scanning ? "animate-pulse bg-emerald-400" : "bg-white/30")} /> {scanning ? "Live" : "Idle"}
        </span>
      </div>
      <div ref={ref} role="log" aria-live="polite" className="mt-3 flex max-h-[420px] min-h-[220px] flex-1 flex-col gap-1 overflow-y-auto rounded-2xl bg-black/40 p-3 font-mono text-[11px] leading-5">
        {log.length === 0 ? (
          <div className="text-white/40">
            <p className="text-sky-300">DF<span className="text-white/30">/</span>AGENT</p>
            <p>Ready to inspect U.S. inventory.</p>
            <p className="text-white/25">Set a target and start the scan.</p>
          </div>
        ) : null}
        {log.map((line) => (
          <p key={line.id} className={cn("flex gap-2", tone[line.type])}>
            <span className="shrink-0 text-sky-300/70">{line.mark}</span>
            <span className="break-words">{line.message}</span>
          </p>
        ))}
      </div>
      <p className="mt-2 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.12em] text-white/30">
        <span><i className="mr-1 inline-block size-1.5 rounded-full bg-sky-400 align-middle" /> live event stream</span>
        <span>Mistral appraisal core</span>
      </p>
    </section>
  );
}

// --- Deal card ----------------------------------------------------------------

function ScoreRing({ score, color, pending }: { score: number; color: string; pending: boolean }): React.ReactElement {
  const [deg, setDeg] = React.useState(0);
  React.useEffect(() => {
    if (pending) return undefined;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reduced ? 0 : 720;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const progress = duration ? Math.min(1, (now - start) / duration) : 1;
      const eased = 1 - Math.pow(1 - progress, 3);
      setDeg(score * 3.6 * eased);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [score, pending]);
  return (
    <div
      aria-label="Deal score"
      className="flex size-14 shrink-0 items-center justify-center rounded-full p-[3px]"
      style={{ background: `conic-gradient(${color} ${deg}deg, rgba(255,255,255,0.08) 0)` }}
    >
      <div className="flex h-full w-full items-center justify-center rounded-full bg-[#19191e] text-base font-bold" style={{ color }}>
        {pending ? "…" : score}
      </div>
    </div>
  );
}

function DealCard({ listing, rank, trace, flipped, analyzing, onFlip, onOpenProduct, onOpenTrace }: {
  listing: DealListing;
  rank: number | null;
  trace: TraceLine[];
  flipped: boolean;
  analyzing: boolean;
  onFlip: (flipped: boolean) => void;
  onOpenProduct: () => void;
  onOpenTrace: () => void;
}): React.ReactElement {
  const score = Math.round(clamp(listing.deal?.score, 0, 100));
  const tone = scoreTone(score);
  const flags = Array.isArray(listing.deal?.flags) ? listing.deal!.flags! : [];
  const sus = flags.includes("too_good");
  const delta = Number(listing.fairValue) - Number(listing.price);
  const demand = clamp(listing.demand?.value, 0, 1);
  const confidence = clamp(listing.deal?.confidence, 0, 1);
  const discount = Number(listing.fairValue) > 0 ? Math.round((1 - Number(listing.price) / Number(listing.fairValue)) * 100) : 0;
  const image = safeUrl(listing.imageUrl);
  const [broken, setBroken] = React.useState(false);
  const terminalRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight }); }, [trace]);

  const photo = image !== "#" && !broken ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={image} alt={`${safeText(listing.title, "Listing")} photo`} loading="lazy" decoding="async" onError={() => setBroken(true)} className="h-full w-full object-cover" />
  ) : (
    <div className="flex h-full w-full items-center justify-center text-[10px] uppercase tracking-[0.12em] text-white/30">Photo unavailable</div>
  );

  return (
    <article
      data-testid="deal-card"
      className={cn("overflow-hidden rounded-2xl border bg-[#19191e] transition-colors", sus ? "border-red-400/40" : analyzing ? "border-sky-400/30" : rank === 1 ? "border-emerald-400/40" : "border-white/10")}
      style={{ ["--score-color" as string]: tone.color }}
    >
      {!flipped ? (
        <div className="flex gap-3 p-3">
          <button type="button" onClick={onOpenProduct} disabled={analyzing} className="size-24 shrink-0 overflow-hidden rounded-xl bg-white/5" aria-label="Open product opportunity details">{photo}</button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.12em]">
              <span className={cn(rank === 1 ? "text-emerald-300" : "text-sky-300")}>{rank ? `#${String(rank).padStart(2, "0")} · ${rank === 1 ? "Top pick" : "Finder pick"}` : "Candidate · analyzing"}</span>
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-white/60">{discount >= 0 ? "−" : "+"}{Math.abs(discount)}% vs market</span>
              {sus ? <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-red-300">SUS</span> : null}
              <button type="button" onClick={() => onFlip(true)} aria-label="Flip card to view agent trace" className="ml-auto rounded-md border border-white/10 px-1.5 py-0.5 text-white/50 hover:text-white">&gt;_</button>
            </div>
            <button type="button" onClick={onOpenProduct} className="mt-1.5 block w-full text-left" aria-label="Open product opportunity details">
              <h4 className="line-clamp-2 text-sm font-semibold leading-5 text-white/90">{safeText(listing.title, "Untitled listing")}</h4>
              <p className="mt-0.5 text-xs text-white/45">{listingPlace(listing)} · {postedAgo(listing.postedAt)} · <strong className="text-white/75">{money(listing.price)} asking</strong></p>
              <p className="mt-1.5 flex flex-wrap gap-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-white/45">
                <span className="rounded-full border border-white/10 px-2 py-0.5">{Math.round(demand * 100)} demand · {safeText(listing.demand?.source, "baseline")}</span>
                <span className="rounded-full border border-white/10 px-2 py-0.5">{Math.round(confidence * 100)}% confidence</span>
              </p>
            </button>
          </div>
          <div className="flex shrink-0 flex-col items-end justify-between gap-1 text-right">
            <ScoreRing score={score} color={tone.color} pending={analyzing} />
            <div>
              <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-white/40">Estimated upside</p>
              <p className={cn("text-base font-bold", delta >= 0 ? "text-emerald-300" : "text-red-300")}>{delta >= 0 ? "+" : "−"}{money(Math.abs(delta))}</p>
              <p className="text-[11px] text-white/40">{money(listing.fairValue)} fair value</p>
              <button type="button" onClick={() => onFlip(true)} className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-sky-300 hover:text-white">Agent trace &gt;_</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 bg-[#0c0c10] p-3" aria-label="Agent trace and live evidence">
          <header className="flex items-start justify-between gap-2">
            <div>
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-sky-300">DF / Agent trace</p>
              <h4 className="line-clamp-1 text-sm font-semibold">{safeText(listing.title, analyzing ? "Inspecting listing" : "Completed analysis")}</h4>
            </div>
            <button type="button" onClick={() => onFlip(false)} disabled={analyzing} aria-label="Return to product" className="flex size-7 items-center justify-center rounded-full text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-30"><X className="size-4" /></button>
          </header>
          <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.12em] text-white/45">
            <span className="flex items-center gap-1.5"><span className={cn("size-1.5 rounded-full", analyzing ? "animate-pulse bg-sky-400" : "bg-emerald-400")} /> {analyzing ? "Live evidence" : "Analysis complete"}</span>
            <span>{money(listing.price)} ask</span>
          </div>
          <div ref={terminalRef} role="log" aria-live="polite" className="max-h-40 min-h-[96px] overflow-y-auto rounded-xl bg-black/50 p-2.5 font-mono text-[11px] leading-5">
            {trace.map((line, index) => (
              <p key={index} className={cn("flex gap-2", line.tone === "success" ? "text-emerald-300" : line.tone === "error" ? "text-red-300" : "text-white/70")}>
                <span className="text-sky-300/70">&gt;</span>
                <span><b className="mr-1 text-white/90">{line.label}</b>{line.message}</span>
              </p>
            ))}
            {analyzing ? <p className="animate-pulse text-white/40">▍</p> : null}
          </div>
          <p className="font-mono text-[9px] uppercase tracking-[0.1em] text-white/30">Structured evidence only — no hidden chain-of-thought.</p>
          <button type="button" onClick={onOpenTrace} disabled={analyzing} className="inline-flex h-9 items-center justify-center gap-1 rounded-xl bg-sky-500/20 text-xs font-medium text-sky-200 hover:bg-sky-500/30 disabled:opacity-40">
            <TerminalSquare className="size-3.5" /> Open full 7-step decision trace ↗
          </button>
        </div>
      )}
    </article>
  );
}

// --- Drawer: product opportunity + decision trace -----------------------------

function Drawer({ drawer, rankIndex, onClose, onOpenTrace }: { drawer: DrawerState; rankIndex: number; onClose: () => void; onOpenTrace: () => void }): React.ReactElement {
  const { listing, isPass, mode } = drawer;
  const score = optionalNumber(listing.deal?.score);
  const tone = scoreTone(score === null ? 0 : Math.round(clamp(score, 0, 100)));
  const closeRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => { closeRef.current?.focus(); }, [mode]);
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <aside role="dialog" aria-modal="true" aria-labelledby="drawer-title" className="fixed inset-y-0 right-0 z-50 flex w-[min(96vw,640px)] flex-col overflow-y-auto border-l border-white/10 bg-[#101014] p-5 text-white shadow-2xl" style={{ ["--score-color" as string]: tone.color }}>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close decision trace" className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full bg-white/5 text-white/70 hover:bg-white/10 hover:text-white"><X className="size-4" /></button>
        {mode === "product" ? <ProductDetails listing={listing} onOpenTrace={onOpenTrace} /> : <DecisionTrace listing={listing} isPass={isPass} rankIndex={rankIndex} />}
      </aside>
    </>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }): React.ReactElement {
  return (
    <div className={cn("rounded-2xl border border-white/10 bg-white/5 p-3", accent && "border-emerald-400/30 bg-emerald-500/5")}>
      <span className="block font-mono text-[9px] uppercase tracking-[0.14em] text-white/45">{label}</span>
      <strong className={cn("mt-1 block text-lg font-semibold", accent && "text-emerald-300")}>{value}</strong>
    </div>
  );
}

function ProductDetails({ listing, onOpenTrace }: { listing: DealListing; onOpenTrace: () => void }): React.ReactElement {
  const ask = optionalNumber(listing.price);
  const fair = optionalNumber(listing.fairValue);
  const upside = ask === null || fair === null ? null : fair - ask;
  const estimate = optionalNumber(listing.valuation?.estimatedResaleUsd);
  const median = optionalNumber(listing.compsMedian);
  const demand = optionalNumber(listing.demand?.value);
  const url = safeUrl(listing.url);
  const show = (value: number | null, format: (value: number) => string) => (value === null ? "not emitted" : format(value));
  return (
    <div className="flex flex-col gap-5 pr-8">
      <header>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-sky-300">Product opportunity</p>
        <h2 id="drawer-title" className="mt-1 text-xl font-semibold leading-6">{safeText(listing.title, "Untitled listing")}</h2>
        <p className="mt-1 text-xs text-white/45">{listingPlace(listing)} · {postedAgo(listing.postedAt)}</p>
      </header>
      <div className="grid grid-cols-3 gap-2">
        <Metric label="Seller asks" value={show(ask, money)} />
        <Metric label="Current fair value" value={show(fair, money)} />
        <Metric label="Estimated gross upside" value={show(upside, (value) => `${value >= 0 ? "+" : "−"}${money(Math.abs(value))}`)} accent />
      </div>
      <section className="rounded-2xl border border-sky-400/20 bg-sky-500/5 p-4">
        <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-sky-300">Why this may make money</span>
        <h3 className="mt-1 text-base font-semibold">{safeText(listing.deal?.headline, "The listing is priced below the evidence-backed estimate")}</h3>
        <p className="mt-1 text-sm leading-6 text-white/70">{safeText(listing.deal?.why, listing.valuation?.reasoning || "The result cleared the current score threshold based on margin, demand, and confidence.")}</p>
      </section>
      <div className="grid gap-2 sm:grid-cols-2">
        <Evidence label="Mistral blind appraisal" value={show(estimate, money)} copy={safeText(listing.valuation?.reasoning, "No appraisal explanation was emitted.")} />
        <Evidence label="Craigslist market evidence" value={show(median, money)} copy={`Median asking price across ${safeText(listing.compsN, 0)} search results. Asking prices are not confirmed sales.`} />
        <Evidence label="Demand signal" value={demand === null ? "—" : `${Math.round(clamp(demand, 0, 1) * 100)}%`} copy={`${safeText(listing.demand?.keyword, "Category")} via ${safeText(listing.demand?.source, "baseline")}; a demand proxy, not sales volume.`} />
        <Evidence label="What could break the deal" value="Verify before buying" copy={safeText(listing.deal?.riskNote, "No specific risk was emitted. Inspect the item and verify the seller before buying.")} risk />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onOpenTrace} className="inline-flex h-10 items-center gap-1 rounded-full bg-sky-500 px-4 text-sm font-medium text-white hover:bg-sky-400">Open full 7-step decision trace ↗</button>
        {url !== "#" ? <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center gap-1 rounded-full border border-white/15 px-4 text-sm text-white/80 hover:bg-white/5">Open on Craigslist <ExternalLink className="size-3.5" /></a> : <span className="text-xs text-white/40">Listing URL not emitted</span>}
      </div>
      <p className="text-xs leading-5 text-white/40">Upside is fair value minus asking price before fees, shipping, repairs, tax, or negotiation. It is an estimate, not guaranteed profit.</p>
    </div>
  );
}

function Evidence({ label, value, copy, risk }: { label: string; value: string; copy: string; risk?: boolean }): React.ReactElement {
  return (
    <section className={cn("rounded-2xl border border-white/10 bg-white/5 p-3", risk && "border-amber-400/30 bg-amber-500/5")}>
      <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-white/45">{label}</span>
      <strong className={cn("mt-1 block text-base font-semibold", risk && "text-amber-200")}>{value}</strong>
      <p className="mt-1 text-xs leading-5 text-white/60">{copy}</p>
    </section>
  );
}

function DecisionTrace({ listing, isPass, rankIndex }: { listing: DealListing; isPass: boolean; rankIndex: number }): React.ReactElement {
  const [replay, setReplay] = React.useState(0);
  const scoreRaw = optionalNumber(listing.deal?.score);
  const score = scoreRaw === null ? null : Math.round(clamp(scoreRaw, 0, 100));
  const price = optionalNumber(listing.price);
  const median = optionalNumber(listing.compsMedian);
  const estimate = optionalNumber(listing.valuation?.estimatedResaleUsd);
  const computedFair = median !== null && estimate !== null ? 0.4 * median + 0.6 * estimate : null;
  const fairValue = computedFair ?? optionalNumber(listing.fairValue);
  const demand = optionalNumber(listing.deal?.demand) ?? optionalNumber(listing.demand?.value);
  const margin = optionalNumber(listing.deal?.margin);
  const marginN = optionalNumber(listing.deal?.marginN) ?? (margin === null ? null : (clamp(margin, -1, 2) + 1) / 3);
  const confidence = optionalNumber(listing.deal?.confidence);
  const scoreFlags = Array.isArray(listing.deal?.flags) ? listing.deal!.flags! : [];
  const redFlags = Array.isArray(listing.valuation?.redFlags) ? listing.valuation!.redFlags! : [];
  const flags = Array.from(new Set([...scoreFlags, ...redFlags]));
  const tooGood = scoreFlags.includes("too_good");
  const image = safeUrl(listing.imageUrl);
  const url = safeUrl(listing.url);
  const sourceLabel = demandSourceLabel(listing.demand?.source);
  const condition = safeText(listing.valuation?.condition || listing.condition, "not emitted");
  const item = safeText(listing.valuation?.item, "not emitted");
  const brandModel = safeText(listing.valuation?.brandModel, "model not identified");
  const traceNumber = String(Math.max(0, rankIndex) + 1).padStart(2, "0");
  const scaleValues = [price, median, estimate, fairValue].filter((value): value is number => value !== null);
  const maxScale = Math.max(...scaleValues, 1) * 1.14;
  const position = (value: number | null) => (value === null ? 50 : clamp((value / maxScale) * 100, 4, 96));
  const agreement = median !== null && estimate !== null ? Math.abs(median - estimate) / Math.max(median, 1) < 0.2 : false;
  const bucket = score === null ? "not scored" : scoreTone(score).bucket;
  const percent = (value: number) => `${Math.round(clamp(value, 0, 1) * 100)}%`;
  const show = (value: number | null, format: (value: number) => string) => (value === null ? "not emitted" : format(value));
  const [broken, setBroken] = React.useState(false);

  const thought = {
    look: listing.valuation ? `I identified ${brandModel !== "model not identified" ? brandModel : item} and rated its visible condition ${condition}.` : "This pass event did not include the vision appraisal payload.",
    flags: redFlags.length ? `I found ${redFlags.length} visual or listing warning${redFlags.length === 1 ? "" : "s"} before pricing it.` : "Nothing in the emitted appraisal triggered a red flag.",
    blind: estimate === null ? "No blind appraisal was emitted for this pass." : `I priced the item at ${money(estimate)} without seeing the seller's ${show(price, money)} ask.`,
    comps: median === null || estimate === null ? "The pass event did not carry enough market evidence to compare appraisals." : `Comps say ${money(median)}, I say ${money(estimate)} — ${agreement ? "we roughly agree, confidence up" : "the gap is meaningful, so confidence comes down"}.`,
    demand: demand === null ? "No demand signal was included in this pass event." : `${safeText(listing.demand?.keyword, "This category")} is at ${percent(demand)} demand using ${sourceLabel}.`,
    score: score === null ? `The agent passed this listing: ${safeText(listing.reason, "no numeric score was emitted")}.` : `Weighted evidence lands at ${score}/100 — this belongs in the ${bucket.toUpperCase()} bucket.`,
    verdict: safeText(listing.deal?.headline, listing.reason || "The agent did not surface this listing as a deal."),
  };
  const weighted = [
    { label: "MARGIN", weight: "50%", value: marginN, color: "#fb923c" },
    { label: "DEMAND", weight: "30%", value: demand, color: "#38bdf8" },
    { label: "CONFIDENCE", weight: "20%", value: confidence, color: "rgba(255,255,255,0.5)" },
  ];
  const steps: { id: string; kicker: string; title: string; meta?: string; thought: string; body: React.ReactNode }[] = [
    {
      id: "look", kicker: "01 / Input", title: "Look", meta: "mistral-medium · vision", thought: thought.look,
      body: (
        <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
          <div className="aspect-square overflow-hidden rounded-xl bg-white/5">
            {image !== "#" && !broken ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={image} alt={`${safeText(listing.title)} listing photo`} onError={() => setBroken(true)} className="h-full w-full object-cover" />
            ) : <div className="flex h-full items-center justify-center p-2 text-center text-[10px] uppercase tracking-[0.1em] text-white/35">Photo unavailable · description-only analysis</div>}
          </div>
          <div>
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-white/45">Mistral saw:</span>
            <strong className="mt-1 block text-base">{item}</strong>
            <p className="text-sm text-white/65">{brandModel}</p>
            <b className="mt-2 inline-block rounded-full bg-white/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-white/70">{condition}</b>
          </div>
        </div>
      ),
    },
    {
      id: "flags", kicker: "02 / Safety", title: "Red flags", thought: thought.flags,
      body: <div className="flex flex-wrap gap-1.5">{redFlags.length ? redFlags.map((flag) => <span key={flag} className="rounded-full bg-red-500/15 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-red-200">{flag}</span>) : <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-emerald-200">None ✓</span>}</div>,
    },
    {
      id: "appraisal", kicker: "03 / Price-blind", title: "Blind appraisal", meta: "Asking price hidden", thought: thought.blind,
      body: (
        <div>
          <div className="text-3xl font-bold" style={{ color: "var(--score-color)" }}>{show(estimate, money)}</div>
          <blockquote className="mt-2 border-l-2 border-white/15 pl-3 text-sm italic leading-6 text-white/65">“{safeText(listing.valuation?.reasoning, "No appraisal reasoning was emitted with this pass event.")}”</blockquote>
          <p className="mt-2 font-mono text-[9px] uppercase tracking-[0.14em] text-white/40">Mistral did not see the asking price.</p>
        </div>
      ),
    },
    {
      id: "comps", kicker: "04 / Calibration", title: "Market comps", meta: `N=${safeText(listing.compsN, "—")}`, thought: thought.comps,
      body: (
        <div>
          <div className="flex gap-4 font-mono text-[10px] uppercase tracking-[0.1em] text-white/50"><span>Ask <b className="text-white">{show(price, money)}</b></span><span>Comps median <b className="text-white">{show(median, money)}</b></span></div>
          <div className="relative mt-8 mb-6 h-px w-full bg-white/20" aria-label="Price comparison number line">
            {([["ASKING", price, "#fb923c"], ["FAIR VALUE", fairValue, "#34d399"], ["COMPS", median, "#38bdf8"], ["MISTRAL", estimate, "#c4b5fd"]] as [string, number | null, string][]).filter((entry) => entry[1] !== null).map(([label, value, color], index) => (
              <span key={label} className="absolute -translate-x-1/2 text-center font-mono text-[8px] uppercase tracking-[0.08em]" style={{ left: `${position(value)}%`, top: index % 2 ? "6px" : "-26px" }}>
                <i className="mx-auto block size-2 rounded-full" style={{ background: color }} />
                <b className="block text-white/60">{label}</b>
                <em className="not-italic text-white/85">{money(value)}</em>
              </span>
            ))}
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-white/50">Fair value = 0.4 × comps + 0.6 × Mistral = <b className="text-white">{show(fairValue, money)}</b></p>
        </div>
      ),
    },
    {
      id: "demand", kicker: "05 / Velocity", title: "Demand", meta: sourceLabel, thought: thought.demand,
      body: (
        <div>
          <div className="relative h-6 w-full overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-sky-400" style={{ width: `${demand === null ? 0 : clamp(demand, 0, 1) * 100}%` }} /><b className="absolute inset-y-0 right-3 flex items-center text-xs">{demand === null ? "—" : Math.round(clamp(demand, 0, 1) * 100)}</b></div>
          <div className="mt-2 flex justify-between font-mono text-[10px] uppercase tracking-[0.1em] text-white/50"><span>{safeText(listing.demand?.keyword, "keyword not emitted")}</span><b>{sourceLabel}</b></div>
        </div>
      ),
    },
    {
      id: "score", kicker: "06 / Synthesis", title: "Score", meta: tooGood ? "SUS" : undefined, thought: thought.score,
      body: (
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-white/50">100 × (0.50 margin + 0.30 demand + 0.20 confidence)</p>
          <div className="mt-2 space-y-1.5">
            {weighted.map((row) => (
              <div key={row.label} className="grid grid-cols-[110px_1fr_44px] items-center gap-2 font-mono text-[10px] uppercase tracking-[0.08em] text-white/60">
                <span>{row.label} <b className="text-white/40">{row.weight}</b></span>
                <div className="h-2 overflow-hidden rounded-full bg-white/10"><i className="block h-full rounded-full" style={{ width: `${row.value === null ? 0 : clamp(row.value, 0, 1) * 100}%`, background: row.color }} /></div>
                <em className="text-right not-italic text-white/85">{row.value === null ? "—" : percent(row.value)}</em>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-3"><span className="text-4xl font-bold" style={{ color: "var(--score-color)" }}>{score === null ? "—" : score}</span><div><b className="block font-mono text-[10px] uppercase tracking-[0.12em]">{bucket}</b><small className="text-white/40">/ 100 final</small></div></div>
          {flags.length ? <div className="mt-2 flex flex-wrap gap-1.5">{flags.map((flag) => <span key={flag} className="rounded-full bg-white/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-white/70">{String(flag).replaceAll("_", " ")}</span>)}</div> : null}
          {tooGood ? <p className="mt-2 rounded-xl bg-red-500/10 p-2 text-xs text-red-200">Scam gate tripped: asking {show(price, money)} is below 20% of fair value {show(fairValue, money)}. The score is capped at 40.</p> : null}
        </div>
      ),
    },
    {
      id: "verdict", kicker: "07 / Output", title: "Verdict", thought: thought.verdict,
      body: (
        <div>
          <h4 className="text-base font-semibold">{safeText(listing.deal?.headline, isPass ? "PASS — BELOW THE DEAL THRESHOLD" : "AGENT VERDICT NOT EMITTED")}</h4>
          <p className="mt-1 text-sm leading-6 text-white/70">{safeText(listing.deal?.why, listing.reason || "No explanation was emitted.")}</p>
          <p className="mt-2 text-xs leading-5 text-white/55"><b className="mr-1 font-mono text-[9px] uppercase tracking-[0.12em] text-amber-300">Risk note</b>{safeText(listing.deal?.riskNote, "No risk note was emitted with this pass event.")}</p>
          {url !== "#" ? <a href={url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex h-10 items-center gap-1 rounded-full bg-white px-4 text-sm font-medium text-[#17171b] hover:bg-white/90">Open on Craigslist <ExternalLink className="size-3.5" /></a> : <span className="mt-3 inline-block text-xs text-white/40">Listing URL not emitted</span>}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4 pr-8">
      <header>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-sky-300">Decision trace / evidence</p>
        <h2 id="drawer-title" className="mt-1 text-xl font-semibold leading-6">Why this result <span className="text-white/50">· #{traceNumber} {safeText(listing.title, "Untitled listing")}</span></h2>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-white/45">
          <span className="rounded-full bg-white/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-white/70">Mistral</span>
          <span>{listingPlace(listing)} · {postedAgo(listing.postedAt)}</span>
          {isPass ? <span className="rounded-full bg-white/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em]">Pass</span> : null}
        </p>
      </header>
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => setReplay((value) => value + 1)} className="inline-flex h-8 items-center gap-1 rounded-full border border-white/15 px-3 text-xs text-white/75 hover:bg-white/5">Replay decision trace <RotateCcw className="size-3" /></button>
        <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-white/40">7-step decision trace</span>
      </div>
      <ol key={replay} className="flex flex-col gap-3">
        {steps.map((step, index) => (
          <li key={step.id} className={cn("trace-reveal grid grid-cols-[28px_1fr] gap-3", tooGood && step.id === "score" && "text-red-100")} style={{ animationDelay: `${80 + index * 350}ms` }}>
            <div className="flex flex-col items-center"><span className="font-mono text-[10px] text-white/40">{String(index + 1).padStart(2, "0")}</span><span className="mt-1 w-px flex-1 bg-white/10" /></div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-sky-300">{step.kicker}</span>
                <b className="text-sm font-semibold uppercase tracking-[0.08em]">{step.title}</b>
                {step.meta ? <em className="font-mono text-[9px] uppercase not-italic tracking-[0.1em] text-white/40">{step.meta}</em> : null}
              </div>
              <p className="mt-1 text-sm italic leading-6 text-white/60">{step.thought}</p>
              <div className="mt-3">{step.body}</div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
