/**
 * REAL market run for the Seller section — same SimState shape as
 * lib/simulation.ts so <MarketSimulation> renders it unchanged, but every
 * conversation is a genuine negotiation: buyer turns are Mistral
 * completions and seller turns are the Python seller agent holding the
 * user's actual bounds, via /api/sell/turn.
 *
 * Buyers run SEQUENTIALLY, not six at once — every round is two model
 * calls, and parallel conversations trip Mistral's rate limit (the reason
 * the scripted simulation exists at all). Real mode trades the swarm for
 * authenticity: fewer buyers, real dialogue.
 */
import type { PurchaseLine } from "@/lib/purchase";
import type { SimAgent, SimState } from "@/lib/simulation";

const MAX_SELL_ROUNDS = 6;
const MAX_REAL_BUYERS = 3;
const EST_MS_PER_BUYER = 30_000;

const NAMES = ["Maya", "Jordan", "Priya", "Luis", "Chen", "Sam", "Ava", "Noah"];
const STYLES: SimAgent["buyer"]["style"][] = ["eager", "cautious", "firm"];

interface SellTurnResponse {
  buyer: { text: string; price: number; accepted: boolean };
  seller: { text: string; price: number | null; accepted: boolean; walkAway: boolean } | null;
  outcome: "continue" | "deal" | "no_deal";
  dealPrice: number | null;
}

export async function runRealMarketSale(args: {
  itemName: string;
  description: string;
  listPrice: number;
  floorPrice: number;
  quantity: number;
  signal: AbortSignal;
  onUpdate: (state: SimState) => void;
}): Promise<SimState> {
  const { itemName, description, listPrice, floorPrice, quantity, signal, onUpdate } = args;
  const startedAt = Date.now();
  const buyerCount = Math.min(MAX_REAL_BUYERS, Math.max(1, quantity + 1));

  const agents: SimAgent[] = Array.from({ length: buyerCount }, (_, index) => ({
    buyer: {
      id: index,
      name: NAMES[Math.floor(Math.random() * NAMES.length)],
      style: STYLES[index % STYLES.length],
      // Real budget spread: somewhere between just under the floor and just
      // over asking, so some buyers genuinely cannot afford the item.
      budget: Math.round(floorPrice * 0.92 + Math.random() * (listPrice * 1.05 - floorPrice * 0.92)),
      openRatio: 0.75,
      step: 0.1,
      patience: MAX_SELL_ROUNDS,
    },
    lines: [],
    offer: null,
    sellerAsk: listPrice,
    status: "waiting",
    turns: 0,
  }));

  const state: SimState = {
    agents,
    elapsedMs: 0,
    durationMs: buyerCount * EST_MS_PER_BUYER,
    quantity,
    sold: 0,
    revenue: 0,
    sales: [],
    bestOffer: null,
    done: false,
  };

  const push = () => {
    state.elapsedMs = Date.now() - startedAt;
    onUpdate({ ...state, agents: agents.map((agent) => ({ ...agent, lines: [...agent.lines] })) });
  };
  push();

  for (const agent of agents) {
    if (signal.aborted || state.sold >= quantity) {
      if (state.sold >= quantity) agent.status = "soldout";
      continue;
    }
    agent.status = "negotiating";
    push();

    const history: PurchaseLine[] = [];
    for (let round = 1; round <= MAX_SELL_ROUNDS; round++) {
      if (signal.aborted) break;
      let turn: SellTurnResponse;
      try {
        const response = await fetch("/api/sell/turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            item: { id: `real-${agent.buyer.id}`, name: itemName, description },
            listPrice,
            floorPrice,
            budget: agent.buyer.budget,
            round,
            history,
          }),
          signal,
        });
        if (!response.ok) throw new Error(`sell turn ${response.status}`);
        turn = await response.json() as SellTurnResponse;
      } catch (error) {
        if (signal.aborted) break;
        throw error;
      }

      history.push({ role: "buyer", text: turn.buyer.text, price: turn.buyer.price });
      agent.lines.push({ role: "buyer", text: turn.buyer.text, price: turn.buyer.price });
      agent.offer = turn.buyer.price;
      agent.turns = round;
      if (state.bestOffer === null || turn.buyer.price > state.bestOffer) state.bestOffer = turn.buyer.price;
      push();

      if (turn.seller) {
        history.push({ role: "seller", text: turn.seller.text, price: turn.seller.price ?? undefined });
        agent.lines.push({ role: "seller", text: turn.seller.text, price: turn.seller.price ?? undefined });
        if (typeof turn.seller.price === "number") agent.sellerAsk = turn.seller.price;
        push();
      }

      if (turn.outcome === "deal" && turn.dealPrice !== null) {
        agent.status = "sold";
        state.sold += 1;
        state.revenue += turn.dealPrice;
        state.sales.push({ buyerName: agent.buyer.name, price: turn.dealPrice, atMs: Date.now() - startedAt });
        break;
      }
      if (turn.outcome === "no_deal") {
        agent.status = agent.buyer.budget < floorPrice ? "maxed" : "walked";
        break;
      }
      if (round === MAX_SELL_ROUNDS) agent.status = "walked";
    }
    if (agent.status === "negotiating") agent.status = "walked";
    push();
  }

  for (const agent of agents) {
    if (agent.status === "waiting") agent.status = "soldout";
  }
  state.done = true;
  state.durationMs = Math.max(1, Date.now() - startedAt);
  push();
  return state;
}
