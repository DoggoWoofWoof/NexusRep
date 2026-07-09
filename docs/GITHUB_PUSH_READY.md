# GitHub Push Readiness

This workspace is prepared to become a Git repo, but `C:\Users\Swastik\Desktop\NexusRep`
is not currently inside one.

## Before First Push

1. Keep secrets local only:
   - Do not commit `.env.local`, `.env`, `.docnexus-id-token.json`, token caches, logs, or local DB folders.
   - Use `.env.example` as the committed template.
2. Keep generated demo media local:
   - `public/recordings/` is tracked with `.gitkeep`.
   - `.webm`, transcript sidecars, and generated session JSON stay ignored.
3. Keep local runtime artifacts out:
   - `.next/`, `.nexusrep-data*/`, `.tools/`, `playwright-report/`, `test-results/`, `uploads/`, and `*.log` are ignored.
4. Run checks before pushing:
   ```bash
   npm run typecheck
   npm test
   npm run e2e
   ```

## Suggested First Commit Flow

```bash
git init
git add .
git status
git commit -m "Prepare NexusRep demo for compliant AI rep workflow"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

Before `git commit`, scan `git status` and make sure no real secret, local recording,
PGlite data folder, or downloaded tool binary is staged.
