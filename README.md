# Ampy — an AI-agent marketplace

Ampy is a full-stack marketplace where AI agents do the work of buying and selling:
a **seller agent** that lists your item, answers buyers, and negotiates within your
price bounds; a **buyer agent** that searches real listings and haggles on your
behalf; and a **deal finder** that scans U.S. Craigslist markets for underpriced
flips. Listings cross-post to Craigslist through a Chrome extension that pre-fills
Craigslist's own posting flow in your browser.

Built on [AliUraish/Ampy](https://github.com/AliUraish/Ampy), substantially extended.

## Architecture

```
frontend/            Next.js UI (:3000) — Seller / Buyer / Reseller tabs, API proxies
backend/
  start.mjs          npm start — boots the full stack
  seller/            Python FastAPI seller agent (:8000) — negotiation with real bounds
  buyer/             Node buyer service (:3001) — search, negotiation, iMessage, extension bridge
  deal-finder/       Node Deal Finder API (:4747) — nationwide Craigslist scans + appraisal
backend/buyer/extension/   Chrome extension ("Ampy bridge") — Craigslist form pre-fill,
                           Facebook Marketplace search in your own signed-in browser
```

All LLM calls go through **Mistral** (chat, vision, and JSON mode).

## Setup

```bash
cp .env.example .env        # then set MISTRAL_API_KEY
npm run install:all         # needs node 18+, and uv for the Python seller
npm start                   # opens http://127.0.0.1:3000
```

Stack health: `GET http://127.0.0.1:3000/api/status`

### Environment variables (root `.env`)

| Variable | Purpose |
|---|---|
| `MISTRAL_API_KEY` | Required — every agent feature uses it |
| `MISTRAL_MODEL` | Chat model (default `mistral-medium-latest`) |
| `USE_MOCK_DATA` | `true` = demo data instead of live Craigslist |
| `CRAIGSLIST_LOCATION` | Default market slug (e.g. `sfbay`, `atlanta`) |
| `CRAIGSLIST_CONTACT_EMAIL` | Pre-filled into Craigslist's reply-options field |
| `SELLER_IMESSAGE_AUTOREPLY` | `true` = seller agent answers incoming iMessages |

## What the agents actually do

### Seller
- **Auto-fill from photos** — Mistral vision drafts title, description, condition,
  and a price range from up to 8 photos.
- **Real negotiation** — publishing starts live buyer agents (Mistral personas with
  their own budgets) negotiating against your seller agent, which defends your
  asking price and never breaks your hidden floor (`/api/sell/turn`). A toggle
  switches to an instant scripted demo; a badge always says which one you're seeing.
- **Craigslist cross-posting** — see below.
- **iMessage auto-responder** — real humans who text about a listing get answers
  from the seller agent: availability and condition from the actual listing data,
  counter-offers within your bounds. Guardrails: it only replies to messages
  confidently matched to an active listing, it **never closes a sale** (a would-be
  acceptance becomes "let me confirm and get back to you" plus a
  `pendingConfirmation` flag for the human), and every send passes daily caps,
  dedupe, and an audit log. Endpoints: `/api/seller-inbox/{status,scan,simulate}`.

### Buyer
- Searches live Craigslist (any U.S. market via the location picker) plus the Ampy
  marketplace. Token-based relevance matching, and **automatic query rewriting**:
  a search with zero results gets rewritten by Mistral into US-market equivalents
  ("honda jazz 2011" → "honda fit 2011") with full transparency in the reply.
- **Buy panel** — a real Mistral buyer agent negotiates the purchase against the
  seller agent, with your budget enforced in code, not in the prompt.

### Reseller / Deal Finder
- Scans 12 priority U.S. Craigslist markets (or any single market) for a target
  item, scores each listing against market comps, and optionally runs a
  per-listing Mistral appraisal (deep scan). Results stream live over SSE.

## Craigslist cross-posting — how it works and why

Craigslist has **no posting API** and prohibits automated posting; its multi-page
flow, CAPTCHA, and email confirmation exist to force a human through the loop.
Ampy automates everything that is legitimately automatable and leaves the human
checkpoints alone:

1. Publish a listing → the **Ampy bridge** extension opens Craigslist's posting
   flow in your own Chrome (using Craigslist's `/fso` deep link).
2. Every page arrives pre-filled: city (matched even against Craigslist's widget
   UI), sub-area (resolved from your ZIP by Mistral against the page's actual
   options — works in any metro), posting type, category, title, price,
   description, ZIP, condition, contact email, and your photos are attached on
   the images step.
3. **You** click continue through the pages, log in, pass any CAPTCHA, and click
   publish. Roughly 15 seconds of clicking — and that boundary is deliberate:
   tools that auto-click Craigslist's flow get postings silently ghosted and
   accounts flagged.

### Extension install (one-time)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select `backend/buyer/extension/`
3. After any extension code change: click the ⟳ reload icon on the card

## iMessage setup (macOS only)

- **Sending** works out of the box; the first send asks you to allow control of
  Messages (System Settings → Privacy & Security → Automation).
- **Reading incoming texts** (needed for the seller auto-responder and for the
  buyer agent to see replies) requires **Full Disk Access** for whatever runs the
  server — Terminal if you run `npm start` yourself (System Settings → Privacy &
  Security → Full Disk Access), then restart the stack.
- `IMESSAGE_DRY_RUN=true` exercises the whole path without sending anything.

## Run pieces alone

```bash
npm run start:seller        # Python seller agent :8000
npm run start:buyer         # buyer service :3001
npm run start:deal-finder   # deal finder :4747
npm run dev:frontend        # Next.js UI :3000
npm run test:deal-finder    # deal finder test suite
```

## Honest-automation policy

Ampy's rule across every marketplace: **automate 100% of what the platform
permits, and not one click more.** Marketplaces with real posting APIs can be
fully one-click; Craigslist gets maximum-legal pre-fill with a human finish. The
same honesty applies inside the product — anything simulated (like the instant
demo mode) is labeled as such in the UI.
