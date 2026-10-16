# Storelens — E-commerce audit workspace

A standalone Node.js application for evidence-based public storefront audits and authorized inventory analysis. Developed independently beside the OfNeeds marketplace, it has its own server, data store, tests and Git repository.

## Open and run

Node.js 24+ is required (the app uses `node:sqlite`). On a machine with enough free disk space:

```powershell
git clone https://github.com/girishnshetty/storelens.git
cd storelens
npm install
npm start
```

Open **http://localhost:4185**. Paste a public store URL and click **Analyze Store**. Individual SEO, image and catalog buttons start separate jobs. Inventory and merchandising buttons use authorized CSV/Excel data attached to the selected scan.

The desktop development environment had very little free disk space. Here, `lib/dependencies.mjs` can reuse the installed desktop runtime's Sharp, PDF, ZIP and Playwright libraries, with the small parser dependencies under `../.tmp/audit-runtime/node_modules`. This fallback is for local development. Normal deployments install the dependencies in `package.json`. Alternatively set `AUDIT_NODE_MODULES` to a semicolon-separated list of module directories. No bundled dependencies are copied or modified.

## Implemented behavior

- Responsive white and navy dashboard; persistent scan progress, empty/error/loading states, health coverage, severity/module distribution, filters, sorting and pagination.
- Server-side public URL scanning with identified user agent, robots policies for each origin, same-origin page discovery, sitemap indexes, collection pagination, and a Shopify public product-feed adapter. WooCommerce and generic HTML use product JSON-LD, public markup, category links and sitemaps. JavaScript-only product data is explicitly outside the current adapter.
- Discovered URL records stay distinct from inspected pages. The product explorer uses server-side pagination. Public-feed availability has its own evidence source; it is not warehouse stock.
- Deterministic SEO and catalog rules, including zero-price offers, title/meta duplication, headings, canonical tags, JSON-LD, description completeness and public metadata consistency. Heuristic findings are labeled Potential Issue. Unavailable checks remain Not Checked or Requires Integration.
- Real image downloads and Sharp decoding, dimensions, file sizes, format opportunities, missing alt attributes, low resolution, aspect ratios, nearly uniform pixels and 64-bit perceptual difference hashes. Similarity is an opportunity for review, not proof of improper reuse. No blur/background claims or image modifications are made.
- Independent Excel, CSV and PDF exports for every module. Excel has Findings, Metadata and Coverage worksheets; CSV includes all three sections. Formula-like CSV values are neutralized, and XLSX text is stored as literal strings. PDF summarizes the first 100 findings; CSV/XLSX retain all rows and Unicode. Unsupported characters in PDF's standard font are represented explicitly as Unicode code points.
- Inventory tabs isolate out-of-stock, fast-moving, slow/non-moving and stock-update requirements. The three export actions download the selected sub-analysis separately.
- Authorized CSV/Excel stock/sales imports, validation, configurable coverage/reorder calculations and evidence-backed merchandising recommendations. Missing values remain unknown, including missing reserved stock and on-order quantities. Uploads are private to their associated scan.
- Editable recommendations, copying and explicit local approval. Optional OpenAI content drafts when the server has `OPENAI_API_KEY`; no publishing or store mutation endpoints exist.
- SQLite WAL persistence, normalized scan/product/page/image/check/issue tables, stable finding IDs, saved crawl checkpoints, restart recovery, pause/resume and scan history. Comparisons require identical URL, module and budget settings and still carry a sample warning.

## Scope and safety of a scan

Defaults: **40 pages**, **80 image downloads**, minimum **800 × 800 px**. Settings allow up to 2,500 pages and 2,000 image downloads. Image checks inspect up to 25 discovered images per product. Discovery has separate limits of 80 sitemap files and 20,000 URLs. Public-feed enrichment samples `ceil(page budget / 250)` feed pages (at most 40); sitemap discovery does not depend on this sample. Internal links sample five per page and 20 unique destinations per scan. UI and reports disclose these limits. These are bounded audits, not claims to fully inspect a large store.

Requests are serialized with at least 800 ms spacing per origin; applicable crawl delays take precedence. HTTP 429 and transient gateway errors have one bounded retry. Long Retry-After values stop that request. Robots 401/403/429/5xx and unusable policies fail closed. No login, CAPTCHA or access restriction is bypassed.

The HTTP client rejects local/reserved network ranges, numeric IP tricks, credentials, custom ports and non-HTTP schemes. It validates all DNS answers, pins the selected public IP into the request, and repeats validation for redirects. Page redirects stay on the submitted origin. Decompressed responses, image pixel counts, timeouts, uploads and unpacked spreadsheets have explicit limits. SVG/active image formats are not decoded. Formula cells and macro-enabled spreadsheets are not accepted for uploads.

Health = `100 × passed weights / completed weights`, with severity weights high=5, medium=3, low=1. Both confirmed and potential rule failures contribute to the score; unknown/integration checks are excluded. Coverage = completed checks / recorded applicable checks. It is **check coverage of the inspected sample**, not whole-store coverage or a prediction of search ranking. Product inspection counts are shown separately.

## Upload contract

Download the header-only template in **Data connections**. CSV UTF-8 and `.xlsx` values-only first worksheets are supported, up to 5 MB / 10,000 rows. SKU must be unique, case-insensitively. Use blank for unknown and **explicit `0` for known zero**.

| Column | Meaning |
|---|---|
| `sku`, `name`, `category` | SKU is required; the others are optional labels. |
| `stock` | Physical on-hand stock before reservations. |
| `reserved` | Committed stock. Required, including explicit zero, to derive available stock. |
| `on_order` | Confirmed incoming units. Required, including explicit zero, for inventory position. |
| `units_7`, `units_30`, `units_60`, `units_90` | Units sold in the specified window ending on the supplied snapshot date. Only the selected window is used for inventory planning. |
| `price` | Unit selling price; use a consistent currency across the upload. |
| `margin_percent` | Verified gross margin, 0–100. |
| `visits_30`, `orders_30` | Visits and orders for the same 30-day window. |
| `age_days` | Verified inventory age. |

Available stock = on hand − reserved. Daily sales = units / window days. Days of cover is undefined for zero/missing sales. Reorder point = daily sales × lead time + safety stock. Target = ceil(daily sales × (lead time + target coverage) + safety stock). Inventory position = available + on order. Reorder = max(0, target − position).

Merchandising heuristics are disclosed in their evidence: fast-moving ≥1 unit/day; slow-moving <0.1/day; no sales = non-moving. Homepage suggestions use the top 20% of uploaded positive 30-day unit sales with available stock. Low conversion uses <1% with ≥100 visits; high conversion / low traffic uses ≥3% with <100 visits. High margin uses ≥40%. These thresholds are review heuristics, not performance guarantees. Category revenue is only a unit-price proxy, excluding discounts, returns and tax. Sales velocity is not asserted from a public listing.

## Configuration and deployment

See `.env.example`. `npm start` uses inherited environment variables. To load an environment file with Node 24 use `node --env-file=.env server.mjs`.

- `PORT` defaults to `4185`; `AUDIT_HOST` defaults to `127.0.0.1`.
- `AUDIT_DATA_DIR` selects durable private storage. Back up the SQLite database using SQLite's backup mechanism or while the app is stopped; account for WAL files.
- `AUDIT_ACCESS_TOKEN` protects every API route. It is mandatory when binding to an external interface. For a team/public deployment, put the app behind HTTPS and real identity/role middleware; this build implements a single protected workspace, not multi-tenant RBAC.
- `AUDIT_ALLOWED_HOSTS` is a comma-separated hostname allowlist for the reverse proxy host; default `localhost,127.0.0.1,[::1]`. Origin checks also apply. Do not expose this app anonymously through a proxy bound on loopback.
- Optional `OPENAI_API_KEY` and `OPENAI_MODEL` (default `gpt-4.1-mini`) enable content suggestions. Keys remain on the server. Review AI drafts for factual accuracy. Public product facts are sent only when a user clicks **Suggest with AI**.

Run **one server process** with a durable data volume and sufficient disk space. The queue has one active job and at most two queued jobs, and API admission is limited to six jobs/minute/client. Jobs run asynchronously in the server process; saved checkpoints enable manual resume after restart. This is a functional local/single-instance implementation. It is **not a distributed production crawler**. PostgreSQL/Prisma migration, Redis/BullMQ workers, centralized auth/RBAC, retention policies and operational monitoring remain necessary for a multi-instance production service. The existing repository architecture was preserved instead of adding an unrelated Next.js stack alongside it.

Not configured: Shopify Admin OAuth, WooCommerce authenticated APIs, GA4, Search Console, PageSpeed Insights and browser-rendering workers. No inventory, margin, traffic or conversion claims are inferred when their data is absent. The UI names these integration requirements. The app is locally served, not published to Sites hosting, because its current scanner and SQLite runtime require a Node server.

## Verification

```powershell
npm test
npm run test:e2e
```

Unit/integration tests use an explicitly synthetic storefront injected into the scanner's HTTP interface; they never seed the live dashboard. Tests cover SSRF rejection, robots denials, parsing, zero pricing, actual image decoding/hashes, unknown score coverage, missing inventory inputs, validation, Excel roundtrips, independent modules, pause/resume, approvals and all **15 module × report format combinations**. The API test uses an isolated temporary persisted database and removes it afterward. Rule tests use an in-memory database to reduce disk use. Browser smoke tests target the already running local app and do not submit scans or change production store data.

The completed initial GI Heritage audit and its measured scope are documented in `VALIDATION.md`. Live records stay in ignored `data/`; no fictitious findings are bundled into source.
