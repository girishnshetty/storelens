# Implementation and live-audit verification

Verified **16 October 2026 (Asia/Kolkata)**. Dashboard: **http://localhost:4185**.

## Initial GI Heritage audit

Live scan ID: `319969c5-a9a2-4af4-95b1-f893219450e9`.

| Evidence | Recorded result |
|---|---:|
| Unique discovered product URLs | 6,673 |
| HTML pages inspected | 40 |
| Product pages successfully inspected | 34 |
| Unique image inspection attempts | 67 |
| Images successfully decoded | 34 |
| Image inspections unavailable | 33 |
| SEO pages with confirmed/potential findings | 40 |
| Products with image opportunities | 29 |
| Products with catalog opportunities | 34 |
| Confirmed SEO rule failures | 46 |
| Potential SEO rule failures | 89 |
| Potential image findings | 32 |
| Confirmed image defects | 0 |
| Potential catalog findings | 35 |
| Confirmed catalog defects | 0 |
| Weighted health score of inspected sample | 91 / 100 |
| Completed recorded checks | 1,846 / 2,136 (86%) |

**This is a bounded sample audit.** It does not mean all 6,673 products were inspected, that the entire store is 91% healthy, or that every opportunity is a confirmed defect. The 40-page budget included the homepage and five collection pages. HTML checks cannot establish client-rendered layout or Core Web Vitals.

Examples of actual evidence include an empty/nonexistent nonempty homepage H1, two identical canonical link tags on inspected pages, heading-level skips, duplicate extracted product descriptions, and decoded product images below the configured 800 × 800 threshold. Resolution findings are potential opportunities, not claims about blur, background quality or whether the full-resolution original is unsuitable. For example, a reviewed image decoded at **1,000 × 488 pixels**, **138,907 bytes**, JPEG.

The 33 unavailable image inspections include cross-origin redirects encountered while establishing access policy. They are marked **Not Checked**, never confirmed broken images. No zero-priced offer was confirmed within this inspected product-page sample. This does not establish that no zero-priced product exists elsewhere.

Public availability was exposed on **1,980 records**: **1,443** were marked `OutOfStock`, **72.9% of known public signals**. Availability is unknown for the remaining 4,693 discovered URLs. These signals do not establish warehouse stock or sales velocity. The resumed development scan retained 1,947 public-feed records; page-derived signals account for the additional known records. Future scans use the documented smaller feed-enrichment budget. Retained feed data is labeled separately from page inspection.

The original bare HTTP request for robots.txt returned 403. The scanner's identified requests subsequently obtained a usable policy and permitted storefront responses. Discovery was interrupted by actual disk exhaustion; the scanner resumed persisted records after task-created temporary databases were removed. URL-derived product labels were excluded from scored name-duplication checks during final rule verification. No synthetic fixture findings were added to this live scan.

## Tests

- **14 / 14 audit unit/API tests passed.** Includes SSRF rejection, robots denials, actual image decoding, zero prices, unknown coverage, inventory edge cases, upload validation, Excel roundtrip, independent modules, local editorial approvals, pause/resume and exclusion of URL-derived names from scoring.
- The API integration test downloaded and parsed all **15 module × format combinations** using explicitly synthetic test-only data. No synthetic sales, inventory or merchandising metrics were attached to the live scan.
- **16 browser smoke checks passed** using Playwright and Chromium/Edge. Desktop and 390px mobile views, all navigation sections, search, review dialog, missing-private-data states and absence of browser JavaScript errors were verified. Screenshots are in `../output/store-audit/`.
- Additional live browser checks verified catalog pagination (**6,673 rows / 223 pages**), the search `bamboo` (**77 matching URLs**), public availability labels, and the decoded image evidence dialog.
- **26 / 26 original OfNeeds marketplace regression tests passed.** No existing marketplace application source or business data was modified. The audit app uses a separate port from the original fixture servers.

## Live report verification

Nine exports were saved to `../output/store-audit/reports/`:

- SEO, image and catalog CSVs, each including metadata, findings and check coverage.
- Three XLSX workbooks, each reopened and verified to contain three worksheets.
- Three readable PDFs: SEO 21 pages, images 13 pages, catalog 18 pages. PDFs summarize at most 100 findings each. Representative SEO and image pages were rendered through Poppler and visually checked for legible text, margins and page numbering. The PDF format is a plain textual summary; use CSV/XLSX for complete records and original Unicode.

`validation.json` records exact scan scope, finding classifications, image inspection coverage, exported filenames and byte counts. Inventory/merchandising reports remain unavailable for this live scan until the user supplies authorized data.

## Remaining configuration and limits

The app is a functional local/single-instance Node implementation, not a completed distributed production service. Its persistent normalized store is SQLite, following the existing repository's lightweight architecture. PostgreSQL/Prisma, Redis-backed workers, multi-user identity/RBAC, retention/monitoring and production HTTPS deployment remain to be provisioned for a shared service. The dashboard is served locally and has not been published to external hosting.

Shopify Admin OAuth, authenticated WooCommerce, GA4, Search Console, PageSpeed and browser-rendered crawling are not configured. Authorized CSV/Excel analysis works independently. Optional AI suggestions are implemented against the Responses API but were not called without credentials; see [official OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-4.1-mini) and the API configuration in README.md.

Disk space on this machine remained very low during delivery. Larger scans require additional free space; dependency-lockfile generation also could not finish because the registry cache exhausted the disk. Partial task-created install caches were removed. Direct dependency versions are pinned in package.json, and the desktop fallback uses the already available runtime. Generate a lockfile and perform a clean normal install on a machine with sufficient storage before production deployment.
