# FuturesTerminal — Owner protection

Private product: **FuturesTerminal**.

## Protection

- Encrypted owner payload in `owner-config.js` (decoded by `shield.js`)
- Host lock for foreign domains (localhost / LAN / `*.github.io` allowed)
- Light anti-tamper (context menu + script filter)

## Runtime connections (required)

- Binance Futures public API — market data
- TradingView widget — chart

No payment backend, Firebase, or landing page.

## Limits

Browser JS cannot be fully locked. Use a private git repo and BitLocker for the project folder.
