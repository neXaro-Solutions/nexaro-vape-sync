# neXaro VAPE Sync 10.0.0

Separate GitHub Actions sync component for the neXaro VAPE catalog. The existing CRM is not modified.

## Scope
Only these manufacturers are accepted:
- ELFBAR
- ELFA
- LOST MARY
- ELFLIQ

Only these neXaro groups are exported:
- Einwegzigaretten
- Prefilled Pods
- Zubehör
- ELFA Liquid

## Strategy
1. Log in to the dealer portal with GitHub Secrets.
2. Try manufacturer search for ELFBAR, ELFA, LOST MARY and ELFLIQ.
3. Crawl search pagination.
4. If manufacturer search yields too little data, automatically fall back to the working logged-in category navigation used by V8.
5. Enrich promising product URLs with detail-page title, breadcrumbs and body text for better classification.
6. Deduplicate and export only the four groups and allowed manufacturers.

No dealer credentials, prices or quantities are committed to the public repository. Output artifacts contain product names/variants/URLs needed for catalog synchronization.
