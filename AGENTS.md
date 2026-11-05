# Agent Guidelines (`homebridge-subarulink`)

## Architecture Overview

- `src/`: TypeScript Homebridge platform (`SubaruLinkPlatform`), accessory mapping (`SubaruVehicleAccessory`), process/RPC client (`SubaruPythonBridge`), and HAP/log helpers (`settings.ts`).
- `python/subaru_bridge.py`: Persistent `asyncio` JSON-RPC daemon over stdio wrapping `G-Two/subarulink` (`>=0.7.21`).
- `scripts/bootstrap-python.mjs`: Bootstraps an isolated Python `>=3.14` runtime and virtual environment inside `<storagePath>/subarulink/.runtime` (or `./.runtime` during local testing).
- `scripts/smoke-test.mjs`: End-to-end verification suite testing upstream Python signatures, JSON-RPC framing, mocked `Controller` telemetry/2FA/crash-recovery flows, and Homebridge v2 cached accessory validation.
- `config.schema.json`: Homebridge UI configuration schema.

## Git & Pull Request Workflow

1. **Never push directly to `main`.** `main` is protected by a GitHub Ruleset requiring pull requests, passing Node 22/24/26 CI checks, linear history, and clean CodeQL results.
2. **Branch naming:** Create short-lived branches off `main` (`fix/<topic>`, `feat/<topic>`, `chore/<topic>`, or `docs/<topic>`).
3. **Local verification before pushing:**
   - Run `pnpm run build` to compile TypeScript cleanly into `dist/`.
   - Run `pnpm test` to execute the smoke and integration suite (run `pnpm run bootstrap` first if `.runtime/` is not yet initialized).
   - Verify `package.json` and `config.schema.json` remain valid JSON and that `"files"` in `package.json` only ships runtime artifacts.
4. **Pull requests & merging:**
   - Open pull requests against `main` using `gh pr create -R misraaks/homebridge-subarulink`.
   - Squash merging and branch auto-deletion are enabled (`gh pr merge --auto --squash`).
5. **Releases & `package.json` versioning:**
   - **Do not** bump `"version"` in `package.json` for routine bug fixes, refactors, docs, or CI chores unless explicitly cutting an npm release.
   - Pushing a new `"version"` in `package.json` to `main` automatically triggers `.github/workflows/publish.yml`, which publishes to npm with OIDC provenance and creates an immutable GitHub Release tag (`vX.Y.Z`).

## Security & Privacy Guardrails

- **Zero secrets or PII:** Never include real MySubaru usernames, passwords, 4-digit PINs, session cookies (`JSESSIONID`), `deviceId`s, `subarulink.cfg` files, or real vehicle VINs in source code, tests, commit messages, or PR descriptions. Use synthetic test values (e.g. `JF2BTANC0R0000001`).
- **Homebridge storage isolation:** Runtime virtualenvs and state files must default strictly to `<Homebridge storagePath>/subarulink/`—never write runtime state into the global `node_modules` plugin directory.
- **Log hygiene:** Ensure error formatters in both `src/settings.ts` and `python/subaru_bridge.py` strip multi-line HTML responses (using loop + angle-bracket sanitization) and redact `RequestInfo` headers/cookies.
