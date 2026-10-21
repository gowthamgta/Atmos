# Working on AtmosIQ

Read `DESIGN-DECISIONS.md` first. It lists the looks and behaviours the owner has agreed (satellite colours, radar drawing, wind particles,
the workflow schedule) and the ones they turned down. Do not change any of them unless the owner asks for that change explicitly; when a
look is to change, ask for a screenshot of what they want. `src/app/core/ui/agreed-look.spec.ts` fails on purpose when an agreed look
changes: update its fingerprint only together with `DESIGN-DECISIONS.md`.

- Angular 21 (signals) with MapLibre; tests: `npx ng test --watch=false` (speed budgets scale with how busy the machine is); build: `npx ng build`; end-to-end: `npx ng build && npx playwright test` (e2e/, saved radar pictures, desktop and phone).
  Pipeline tests: `python -m pytest -q pipeline/tests`. The test workflow runs all of it on every push to main.
- Commit to `main`; if a push is rejected, `git pull --rebase origin main` first (the Actions bot commits data there).
- Other assistants also commit here: run `git log --oneline -10` before trusting what you remember of the code.
