# Contributing

Thanks for your interest in improving Rekindle.

## Ground rules
- **Fictional data only.** Never enter or commit a real patient's name, health details or contact data. Every case in the app and the bench is fictional.
- **The model never names a venue.** Venues come from Qloo and pass the deterministic verifier (`lib/verify.ts`). A change that lets LLM text become a card will not be merged.
- **Nothing on the default path is mocked.** Captured Qloo responses are for unit tests only (`tests/replay.ts`).

## Getting started
1. Fork the repo and branch from `main`: `git checkout -b feat/your-change`
2. `npm ci`
3. `cp .env.example .env.local` and fill in the keys (see the comments in that file)
4. `npm run dev` (http://localhost:3000)

## Before you open a PR
- `npm run check` passes (typecheck, lint, tests, seed / docs / kitchen checks). It needs no keys.
- `npm run build && npm run e2e` passes (Playwright, keyless).
- After a change to the plan path, run `npm run docs` and commit the regenerated `ARCHITECTURE.md` / README lines.
- Add or update tests for any behavior change; name a regression test after the defect it pins.
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:`); `feat` and `fix` cut a release.

## Reporting bugs / requesting features
Open an issue using the templates. Include steps to reproduce, expected vs. actual behavior, and the plan id from the URL if there is one.
Security issues: see [SECURITY.md](SECURITY.md), not a public issue.
