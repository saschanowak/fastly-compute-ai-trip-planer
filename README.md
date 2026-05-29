# AI Trip Planner on Fastly Compute

A conversational travel planning assistant that runs as a **serverless edge computing** application — built on **Fastly Compute** (WebAssembly application) and accelerated by **Fastly AI Accelerator** (semantic LLM cache / AI caching proxy).

Users chat their way to a personalised multi-leg itinerary. The edge function collects five travel preferences, builds a full trip plan via Google Gemini, then enriches it with live weather forecasts and destination photos — all served from the edge.

---

## The problem this solves

Every LLM-powered travel product faces the same cost wall: identical or semantically similar queries ("best beaches in Bali" vs. "top Balinese beach destinations") generate fresh, expensive inference calls every time. Latency is also punishing when your origin LLM provider is on another continent.

**The Fastly solution:** Run the application at the edge (300+ global POPs) and layer the **Fastly AI Accelerator** — a semantic caching layer for LLM APIs — in front of Google Gemini. Cache hits return in milliseconds with zero inference cost. Cache misses are forwarded with minimal added latency.

---

## Architecture / Request Flow

The application runs in three sequential phases per trip generation:

```
Browser
  │
  │  GET /               → chat UI (HTML/CSS/JS, compiled into the WASM bundle)
  │  GET /api/geo        → edge geolocation (pre-fills departure city)
  │  POST /api/chat      → { messages: Message[], departureCity?: string }
  │  POST /api/generate  → { messages: Message[], checklist: Checklist }
  │  POST /api/hotel     → { legIndex, city, startDate, endDate, ... }
  │  POST /api/flights   → { departureCity, firstLegCity, lastLegCity, ... }
  ▼
Fastly Compute  (serverless edge computing / WebAssembly application)
  │
  ├─ Phase A: /api/chat  (chat.ts)
  │    Collects 5 travel preferences in natural conversation.
  │    Calls Gemini 2.5 Flash Lite — fast conversational turns.
  │    ▼
  │  Fastly AI Accelerator → Google Gemini 2.5 Flash Lite
  │
  ├─ Phase B: /api/generate  (generate.ts)
  │    Builds multi-leg trip skeleton via Gemini 3.1 Flash Lite.
  │    Generates plausible hotel + flight stubs — no external tools.
  │    ▼
  │  Fastly AI Accelerator → Google Gemini 3.1 Flash Lite
  │
  ├─ Phase C: enrichment  (enrich.ts)
  │    Parallel edge fan-out for live data:
  │    ├── Open-Meteo        → weather forecasts per leg
  │    └── Wikimedia Commons → destination photos per experience
  │
  └─ Phase D: /api/hotel + /api/flights  (hotel.ts, flights.ts)
       Parallel AI refinement per leg:
       ├── /api/hotel   → Gemini generates realistic hotel data + Trivago booking link
       └── /api/flights → Gemini generates realistic flight data + Skyscanner booking link
```

**Fastly products used:**

| Fastly product | Generic capability |
|---|---|
| Fastly Compute | Serverless edge computing, WebAssembly application |
| Fastly AI Accelerator | Semantic LLM cache, AI caching proxy |
| Secret Store | Edge secrets management, credential storage |
| Bot Management | Bot detection, scraper mitigation |
| DDoS Protection | Denial of Service mitigation |

---

## Prerequisites

- [Fastly account](https://www.fastly.com/signup) with AI Accelerator enabled
- [Fastly CLI](https://developer.fastly.com/reference/cli/) v10+
- [Node.js](https://nodejs.org) v20+
- [Terraform](https://www.terraform.io/downloads) v1.5+ (for provisioning)
- A Google Gemini API key — get one at [Google AI Studio](https://aistudio.google.com/apikey)

---

## Quickstart — local development

```bash
# 1. Install dependencies
npm install

# 2. Create the secrets directory and add your API key
mkdir -p secrets
echo "YOUR_GEMINI_KEY" > secrets/GCP_API_KEY.txt

# 3. Run the local edge simulator (Viceroy)
npm run start
# → open http://localhost:7676
```

Chat with the planner, answer the five questions, and watch the multi-leg trip cards render.

---

## Deploy to production

### 1. Provision infrastructure with Terraform

```bash
cd terraform
terraform init
terraform apply -var="domain_name=ai-trip-planer.edgecompute.app"
```

Terraform creates the Fastly Compute service, enables the AI Accelerator product, adds the required backends, and creates the Secret Store.

### 2. Upload the API key to the Secret Store

```bash
# Get the Secret Store ID from Terraform output or:
fastly secret-store list

fastly secret-store-entry create \
  --store-id <SECRET_STORE_ID> \
  --name GCP_API_KEY \
  --secret "$(cat secrets/GCP_API_KEY.txt)"
```

### 3. Build and deploy the Compute package

```bash
npm run deploy
# Compiles TypeScript → WASM → packages → uploads to Fastly
```

### 4. Update fastly.toml with your Service ID

After `terraform apply`, copy the service ID from the output into `fastly.toml`:

```toml
service_id = "YOUR_SERVICE_ID_HERE"
```

---

## Validation / Smoke Tests

```bash
# Check the UI is served
curl -si https://ai-trip-planer.edgecompute.app/ | head -5

# Check geolocation endpoint
curl -s https://ai-trip-planer.edgecompute.app/api/geo | jq .

# Test the chat API (Phase A)
curl -s https://ai-trip-planer.edgecompute.app/api/chat \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"I want to go to Bali"}]}' \
  | jq -r '.reply'

# Verify 405 on wrong method for /api/chat
curl -si https://ai-trip-planer.edgecompute.app/api/chat -X GET | head -1
# → HTTP/2 405

# Verify 404 on unknown path
curl -si https://ai-trip-planer.edgecompute.app/unknown | head -1
# → HTTP/2 404
```

---

## How the conversation works

### Phase A — Collecting preferences (`/api/chat`)

The AI collects five key data points in natural, conversational English — one or two questions at a time:

1. **Destination** — travel destination (or "Surprise me")
2. **Departure city** — pre-filled from edge geolocation, user just confirms
3. **Travellers** — solo / couple / family (including children's ages)
4. **When** — travel period or duration (exact dates needed for hotel search)
5. **Interests** — style, budget, and interests summarised (e.g. "Luxury, Golf, Beach Club")

Each response includes a `checklist` JSON object tracking which fields are `filled` or `pending`. The frontend shows a live checklist so users can see their progress.

### Phase B — Trip generation (`/api/generate`)

Once preferences are collected (or the user requests generation early), Gemini builds a **multi-leg itinerary** skeleton:

- **2–4 legs** with contiguous dates, a plausible hotel stub, and plausible outbound/inbound flight stubs per leg
- **Day-by-day activities** (morning / afternoon / evening) with titles, descriptions, category tags, and image search queries
- **Inter-leg transfers** (car, train, or flight)

Hotel prices and booking URLs are initially set to placeholders (`"Loading…"` / `""`). The frontend then calls `/api/hotel` and `/api/flights` in parallel to load realistic data.

### Phase C — Edge enrichment (`enrich.ts`)

After the skeleton is built, the edge fan-out enriches it in parallel:

- **Open-Meteo** — live weather forecast (or historical climate averages for future dates) for each leg's dates and location
- **Wikimedia Commons** — destination photos for the overall hero image, each leg's gallery, hotel images, and individual experience cards

### Phase D — AI-generated hotel & flight data

The frontend calls these endpoints in parallel after receiving the skeleton:

- **`/api/hotel`** — Gemini generates realistic hotel data (real hotel names, neighbourhood, stars, score, review count, price) with a Trivago booking deep link
- **`/api/flights`** — Gemini generates realistic flight data (airline, IATA codes, times, duration, stops, cabin class, price) with a Skyscanner booking deep link

---

## Frontend state machine

The single-page app (`src/ui.html`) runs a 4-state machine:

| State | Description |
|---|---|
| `LANDING` | Welcome screen with destination inspiration |
| `PLANNING` | Conversational chat + live checklist panel |
| `GENERATING` | Loading screen while Phase B + C run |
| `PLAN` | Two-column trip plan with legs, days, hotels, flights |

---

## Production considerations

- **API key rotation:** Update the Secret Store entry; no redeployment needed.
- **Cache behaviour:** The AI Accelerator uses semantic similarity — not exact-match — so queries with different wording but the same intent share cached responses.
- **Rate limiting:** Add Fastly Edge Rate Limiting on `/api/chat` and `/api/generate` to prevent abuse.
- **Origin protection:** The Gemini API key is stored exclusively in the Secret Store — it never appears in code or response headers.
- **Conversation state:** The app is intentionally stateless. The browser sends the full message history and checklist with every request. For persistent trip saving, add a Fastly KV Store (edge key-value database).

---

## Teardown / Cleanup

```bash
cd terraform
terraform destroy -var="domain_name=ai-trip-planer.edgecompute.app"
```

This removes the Compute service, Secret Store, and all backends. The API key is deleted with the Secret Store.
