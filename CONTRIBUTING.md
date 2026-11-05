# Contributing to `homebridge-subarulink`

Thanks for your interest in improving `homebridge-subarulink`! To keep maintenance lightweight and safe for everyone, please follow these short guidelines.

## What's Welcome

- **Small PRs welcome directly:** Bug fixes, telemetry edge-case fixes, log hygiene improvements, and documentation/typo fixes can be submitted directly as a Pull Request.
- **Larger features—open an issue first:** Before writing code for new accessories, configuration options, or architectural changes, please [open an issue](https://github.com/misraaks/homebridge-subarulink/issues/new/choose) to confirm it fits the project scope.
- **Upstream MySubaru API issues:** Vehicle protocol and MySubaru API communication are powered by [`G-Two/subarulink`](https://github.com/G-Two/subarulink). Issues with the underlying Subaru API itself belong upstream.

## Safety & Privacy Rules (Required)

- **Never include real vehicle or account data** in code, tests, issue comments, or logs—no real MySubaru credentials, 4-digit PINs, `deviceId`s, `subarulink.cfg` files, session cookies (`JSESSIONID`), or real VINs.
- **Security vulnerabilities:** Do **not** open a public issue or PR for security bugs. Report them privately via [SECURITY.md](.github/SECURITY.md).

## Local Setup & Testing

Prerequisites: **Node.js 22+** and **pnpm**.

```bash
pnpm install
pnpm run build
pnpm run bootstrap   # Downloads an isolated Python >=3.14 venv into ./.runtime (first run only)
pnpm test            # Runs the mocked end-to-end verification suite (no Subaru account needed)
```

## Submitting a Pull Request

1. Fork the repository and create a branch from `main` (e.g., `fix/short-description`).
2. Keep changes focused—one fix or topic per PR.
3. Add or update coverage in `scripts/smoke-test.mjs` when changing runtime behavior.
4. Make sure `pnpm run build` and `pnpm test` pass locally.
5. **Do not bump `"version"` in `package.json`**—releases are cut separately by the maintainer.
6. Open a PR against `main`. All PRs are squash-merged once CI (Node 22/24/26) and CodeQL checks pass.
