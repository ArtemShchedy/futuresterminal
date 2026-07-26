# FuturesTerminal — Owner protection

This project is a private product: **FuturesTerminal**.

## What is protected in code

1. **Host lock** — site refuses to run on foreign domains (`owner-config.js` → `allowedHosts`).
2. **Optional IP lock** — set `allowedIps` and `enforceIpLock: true` to allow only your public IPs.
3. **Anti-tamper shield** — blocks DevTools shortcuts, copy of UI text, injected third-party scripts.
4. **Owner stamp** — `OWNER_TOKEN` in `www/owner-config.js` marks this build as yours.

## What you must set before publishing

Edit `www/owner-config.js` (and the synced root copy):

```js
allowedHosts: [
  'localhost',
  '127.0.0.1',
  'YOUR-DOMAIN.com',
  'www.YOUR-DOMAIN.com'
],
// optional:
enforceIpLock: true,
allowedIps: ['YOUR.PUBLIC.IP.HERE'],
OWNER_TOKEN: 'change-this-to-a-long-secret'
```

## Important limits (honest)

- A website that runs in a browser **cannot** be fully encrypted against a skilled attacker.
- Shield / host / IP locks stop casual copying and foreign hosting — not a substitute for:
  - private Git repository (no public GitHub),
  - Windows BitLocker / EFS for the project folder,
  - server-side access control on your hosting (Cloudflare / nginx IP allowlist).

## Third-party services still used (runtime only)

- Binance Futures public API (market data)
- TradingView chart widget
- Optional Google Fonts / Firebase (Firebase is currently disabled)

These are APIs/widgets, not co-owners of the project. No Watchboard backend remains.
