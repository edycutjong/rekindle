# Convenience targets; npm scripts in package.json are the source of truth.
.PHONY: help check ci e2e e2e-live lighthouse security-scan

help:
	@echo "make check          typecheck + lint + tests + seed/docs/kitchen checks (no keys)"
	@echo "make ci             prod-dependency audit + check + coverage"
	@echo "make e2e            Playwright against a local keyless next start (run npm run build first)"
	@echo "make e2e-live       Playwright against https://rekindle-one.vercel.app, live Qloo calls"
	@echo "make lighthouse     Lighthouse CI on /, /judge, /cases/new (run npm run build first)"
	@echo "make security-scan  npm audit + license check + gitleaks over full history"

check:
	npm run check

ci:
	npm run ci

e2e:
	@echo "Playwright E2E (keyless local server)..."
	npx playwright test

e2e-live:
	npm run e2e:live

lighthouse:
	@echo "Lighthouse CI audit..."
	npm run lighthouse

security-scan:
	@echo "=== NPM AUDIT (all deps) ==="
	npm audit --audit-level=high || true
	@echo "=== LICENSE CHECK ==="
	npm run license
	@echo "=== GITLEAKS (full history) ==="
	gitleaks git --no-banner --redact . || true
