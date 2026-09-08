# neXaro VAPE Sync 1.5

Separate GitHub Actions sync component for the neXaro VAPE module. The existing CRM is not modified by this repository.

## Scope
Only these groups are imported:
- Einwegzigaretten
- Prefilled Pods
- Zubehör
- ELFA Liquid / ELFLIQ

All other product groups are excluded.

## 1.5 improvements
- Crawls all discovered category targets instead of only the first 10.
- Follows pagination/next-page links with configurable limits.
- Produces `out/products.json`, `out/summary.json` and `out/diagnostics.json`.
- Dealer credentials remain GitHub Actions Secrets only.
- No dealer price/quantity data is written to the public repository.

Default limits:
- MAX_CATEGORY_TARGETS=50
- MAX_PAGES_PER_TARGET=30

These can be provided as GitHub Actions environment variables if needed.
