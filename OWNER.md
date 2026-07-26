# FuturesTerminal — Owner protection

This project is a private product: **FuturesTerminal**.

## What is protected

1. **Encrypted owner config** — `www/owner-config.js` stores XOR+Base64 ciphertexts only (`window.__FT_OWN_ENC__`). `shield.js` decrypts them at runtime.
2. **Host lock** — site refuses foreign domains (`h` field → allowed hosts CSV).
3. **Optional IP lock** — set encrypted `i` (IPs CSV) and `f` flag `1|1` (`enforceHost|enforceIp`).
4. **Anti-tamper shield** — DevTools shortcuts, UI copy, injected third-party scripts.
5. **Owner stamp** — decrypted token marks this build as yours.

## Defaults after restore

- Hosts allowed: `localhost`, `127.0.0.1` (+ LAN / `file:` / Capacitor always allowed)
- IP lock: off
- Scripts wired in `app.html` and `index.html` before app code

## Before publishing on your domain

Add your domain into the encrypted hosts list (re-encode CSV with the same key used in `shield.js`), then redeploy `owner-config.js` + `shield.js`.

## Important limits (honest)

- Browser JS **cannot** be fully encrypted against a skilled attacker.
- Shield / host / IP locks stop casual copying and foreign hosting — not a substitute for:
  - private Git repository,
  - BitLocker / EFS for the project folder,
  - server-side access control (Cloudflare / nginx allowlist).
