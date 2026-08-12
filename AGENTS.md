# Cambridge Garden Centre agent workspace

## Repository layout

- `CGC/frontend`: React/Vite frontend deployed to Vercel.
- `CGC/backend`: Express/Prisma backend deployed to Railway.
- `CGC/supabase`: migrations and Edge Functions.
- `.codex/worktrees`: ignored local worktrees for isolated fixes.
- `.codex/artifacts`: ignored local reports, screenshots, and verification evidence.
- `.codex/samples`: ignored client-supplied import fixtures. Never commit client data.

## Working agreement

1. Start by running `git status --short --branch`, `git worktree list`, and `git fetch origin`.
2. Preserve dirty checkouts. Do not switch or reset a worktree containing user-owned changes.
3. Use one focused branch and isolated worktree per issue, normally `codex/<short-slug>` under `.codex/worktrees/<short-slug>`.
4. Base new fixes on the intended remote revision and record the exact base SHA.
5. Stage exact paths. Do not use broad staging when reports, PDFs, screenshots, or temporary files are present.
6. Keep credentials and production data out of Git, output, logs, fixtures, and documentation.

## Required verification

- Frontend: production build, relevant lint, and authenticated browser coverage for the changed flow.
- Backend: Prisma generation, TypeScript build, route/role negative checks, and applicable service tests.
- Dependencies: run both frontend and backend audits when manifests change.
- Database: review migration scope and affected roles before applying; verify both allowed and denied behavior afterward.
- Imports/OCR: validate with sanitized fixtures and confirm persisted order/invoice/ticket results, not only HTTP success.
- Always run `git diff --check` and review the complete branch diff before publishing.

The repository currently lacks comprehensive automated tests and has pre-existing frontend lint failures. Passing builds alone are not end-to-end proof.

## Production boundaries

- Local preparation is not deployment.
- A committed migration is not an applied migration.
- A green PR is not production verification.
- Supabase, Railway, Edge Functions, and Vercel are separate rollout targets; state the exact target for every action.
- Production writes, credential rotation, privilege changes, and destructive cleanup require an explicit preview, exact scope, and approval.

## Pull-request workflow

1. Confirm the issue and acceptance criteria.
2. Create an isolated worktree and scoped branch.
3. Implement the smallest complete cross-layer fix.
4. Run the relevant quality and authenticated workflow gates.
5. Commit intentionally, push the scoped branch, and open a draft PR with evidence and remaining limitations.
6. Do not describe deployment or client UAT as complete unless independently verified.

