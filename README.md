# neXaro VAPE Sync 1.2.0

Separate backend component for synchronizing the dealer portal into the neXaro VAPE catalog.

## Important separation
- This component does **not** modify the existing neXaro CRM.
- No CRM localStorage access.
- No CRM source files are required.
- Dealer credentials stay in server environment variables and are never returned by the API.
- Never commit `.env` to GitHub.

## Included VAPE groups
Exactly these four groups are accepted:
1. Einwegzigaretten
2. Prefilled Pods
3. Zubehör
4. ELFA Liquid / ELFLIQ

Akkuträger and all other groups are excluded.

## Docker
The image is based on the official Playwright image, so Chromium is already included. This avoids a separate browser-install step on the host.

Build:
```bash
docker build -t nexaro-vape-sync .
```

Run:
```bash
docker run --rm -p 8787:10000 \
  -e DEALER_USER='YOUR_CUSTOMER_NUMBER' \
  -e DEALER_PASSWORD='YOUR_PASSWORD' \
  -e DEALER_URL='https://e-zigaretten-handel.de/ezigaretten/' \
  -e HEADLESS='true' \
  nexaro-vape-sync
```

## Environment variables
Required on the server only:
- `DEALER_USER`
- `DEALER_PASSWORD`

Optional:
- `DEALER_URL`
- `DEALER_LOGIN_URL`
- `PRODUCT_URL`
- `LOGIN_USER_SELECTOR`
- `LOGIN_PASSWORD_SELECTOR`
- `LOGIN_SUBMIT_SELECTOR`
- `CSV_EXPORT_SELECTOR`
- `HEADLESS` (default `true`)
- `PORT` (default `8787`, Render blueprint uses `10000`)

## Endpoints
Health:
`GET /health`

Sync:
`POST /sync`

Filter test:
`POST /filter` with `{ "items": [...] }`

## Safety
No CAPTCHA/2FA bypass is implemented. If the dealer portal requires additional authentication, complete the portal's normal authentication flow or configure supported selectors.
