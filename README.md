# Ops Ledger

To-do tracker for Hallaway KL, Hallaway PJ, 农夫鲜生, O-HO and group-level work.
A single static page plus a small serverless backend, so every change is saved
server-side and shows up on any device that opens the site.

The same front-end runs on **Vercel** and **Netlify** — it calls `/api/tasks`, and
each platform has its own function behind that path.

```
ops-ledger/
├── index.html                    the app
├── api/tasks.js                  Vercel function  → Redis (Upstash)
├── netlify/functions/tasks.mjs   Netlify function → Netlify Blobs
├── netlify.toml, _redirects      Netlify config (ignored by Vercel)
├── package.json                  marks the project as ESM; no dependencies
└── .env.example                  variable names for local development
```

## Put it on GitHub

The folder is already a Git repo with everything staged. From inside it:

```bash
git commit -m "Ops Ledger: tracker with serverless backend"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/ops-ledger.git
git push -u origin main
```

Create the empty repo on GitHub first (no README, no .gitignore — this folder has
both). If you prefer the GitHub CLI, `gh repo create ops-ledger --private --source=. --push`
does create-and-push in one step.

Nothing secret is in here. Credentials come from environment variables that the
Upstash integration sets on Vercel, and `.gitignore` keeps `.env` files out.

## Deploy on Vercel

1. **Import the repo.** vercel.com → Add New → Project → import `ops-ledger`.
   Framework preset: **Other**. No build command, no output directory. Deploy.
2. **Add the database.** In the project: Storage → Marketplace → **Upstash for
   Redis** → create a database and connect it to this project. That injects
   `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you.
3. **Redeploy** (Deployments → ⋯ → Redeploy). Functions only pick up environment
   variables on a fresh deploy, so the first deploy won't work until you do this.
4. Open `https://your-project.vercel.app/api/tasks`. You should see
   `{"rev":0,"updatedAt":null,"data":{...}}`. If it says "No Redis credentials",
   step 2 or 3 didn't take.

After that, every `git push` to `main` redeploys automatically. Your tasks live in
Redis, not in the deployed files, so deploys never disturb them.

### Why Redis and not Vercel Blob

Vercel's own KV product was retired and existing stores were moved to Upstash, so
Redis via the Marketplace is the supported key-value path. Vercel Blob would also
work, but it's object storage served through a CDN — fine for uploads, awkward for
one small document that changes all day, and it has no atomic compare-and-set.
Redis does, which is what keeps two people saving at the same time from
overwriting each other. Upstash bills per request; a task list makes a handful of
requests per person per day, so check the current free-tier limits — this should
sit well inside them.

## How saving works

- The browser holds a version number (`rev`) and sends it with every save.
- The function only writes if that `rev` still matches what's stored — one Lua
  script, so the check and the write can't be interleaved. If it doesn't match you
  get `409` plus the current version, and the browser replays your edit on top and
  retries.
- The page re-checks the server every 20 seconds and when you refocus the tab.
- Lost connection shows "Not saved — retrying" and retries every 5 seconds; closing
  the tab with unsaved edits warns you first.
- The last 20 saves are kept as snapshots in `ops-ledger:backups`, readable from the
  Upstash console.
- **Download a copy** / **Restore from a file** at the bottom of the page are your
  manual backup and your way to import data from the old version of the tracker.

## Access

Anyone with the URL can read and edit — there's no login. Vercel URLs are
guessable, so treat this as unlisted rather than private, and keep anything
sensitive out of task notes. The function validates everything it receives (field
types, 1 MB cap, 2000 tasks per brand), but it can't tell your edits from a
stranger's. If you want it locked down, Vercel password protection (paid) or a
shared-password check inside the function are both small additions.

## Local development

```bash
npm i -g vercel
vercel link          # connect this folder to the Vercel project
vercel env pull .env.development.local
vercel dev           # http://localhost:3000
```

Note that `vercel dev` talks to the same Redis as production. Create a second
Upstash database if you want to experiment without touching live tasks.

## Still deploying to Netlify?

The Netlify files are untouched and still work — drag the folder onto
app.netlify.com/drop, or `netlify deploy --prod --dir . --functions netlify/functions`.
Both deployments can be live at once, but they keep **separate** task lists, since
each stores data in its own backend. Pick one as the real thing to avoid confusion.
