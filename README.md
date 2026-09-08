# neXaro VAPE Sync 1.3.0 — GitHub Actions

Separate sync component for the neXaro VAPE catalog. **This repository does not modify the existing neXaro CRM.**

## What this version does

- Runs Playwright in a GitHub-hosted runner.
- Logs into the dealer portal using GitHub Actions Secrets.
- Extracts product metadata and filters strictly to:
  1. Einwegzigaretten
  2. Prefilled Pods
  3. Zubehör
  4. ELFA Liquid
- Produces `out/products.json` and `out/summary.json` as a short-lived GitHub Actions artifact.
- Does **not** write dealer credentials into source code.
- Does **not** sync dealer EK prices into the public repository.
- Can be started manually or every 6 hours.

## GitHub Secrets required

`DEALER_USER` and `DEALER_PASSWORD` are required.

Optional secrets:
- `DEALER_LOGIN_URL`
- `PRODUCT_URL`
- `LOGIN_USER_SELECTOR`
- `LOGIN_PASSWORD_SELECTOR`
- `LOGIN_SUBMIT_SELECTOR`

## Important

The current workflow is intentionally a **validation/sync stage**. The existing CRM is not changed and no catalog file is committed publicly. The generated artifact is retained for 7 days. A later integration step can consume the validated catalog through a protected backend/API.

No CAPTCHA or 2FA bypass is implemented.
