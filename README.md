# Electrical Submission QC Tracker

Internal tool for EHAF Consulting Engineers to log electrical submissions, track their QC checklist status, and get AI-assisted review suggestions against the actual KSRT project files. Styled with the EHAF Design System.

## Run it

```bash
npm install
npm start
```

Then open http://localhost:4173

Data is stored in a local SQLite database at `data/qc-tracker.db` (created automatically on first run, using Node's built-in `node:sqlite` — no native build tools required).

## Enabling "Run AI Review" (Part 2)

The AI review calls Google's Gemini API, so it needs a key:

1. Get a key from Google AI Studio: https://aistudio.google.com/apikey
2. Copy `.env.example` to `.env`
3. Set `GEMINI_API_KEY=...` in that file
4. Restart the server (`npm start`)

Optionally set `GEMINI_MODEL` in `.env` to override the default (`gemini-3.1-pro-preview`). Note: some API keys' free tier has zero quota for Pro-tier models — if "Run AI Review" fails with a 429/quota error, either enable billing on the Google AI Studio project or set `GEMINI_MODEL=gemini-2.5-flash`.

Without a key, the app still works fully for manual logging — clicking "Run AI Review" just shows a message telling you to set the key.

## What's included

**Part 1 — app shell:**
- Log a new submission (project name, RIBA stage, submission date, notes)
- Fixed 8-item QC checklist per submission, each with a status (Checked / Mismatch Found / Not Applicable) and a note
- Dashboard listing all submissions with a mismatch-count summary per submission
- Edit or delete a submission (deleting a submission removes its checklist entries)
- All data persists in SQLite, not in-memory

**Part 2 — AI-assisted review:**
- "Run AI Review" reads calculation, BOQ, specification, and concept-report PDFs and asks Google Gemini (`gemini-3.1-pro-preview` by default) to propose findings for three checklist items. Documents come from one of two places:
  - **Upload** — file inputs above the checklist let you attach PDFs directly through the browser for that run. This is the only path that works on a deployed host, since it never touches the server's local filesystem (files are held in memory for the one request and never written to disk).
  - **Local KSRT folder (dev fallback)** — if no files are uploaded, the app falls back to reading from folders next to this app on disk (`server/ksrtDocuments.js` lists the exact paths). Only works when running locally with those files actually present; a deployed host has no such folder, so uploading is required there.
  - Both paths run through the exact same processing (`server/ksrtDocuments.js`: extract text, apply keyword-excerpting) and the exact same review logic, so results are identical either way — the documents panel after each run shows which source was used.
- For the three checklist items the AI is scoped to:
  - **Calculation → Drawing alignment** and **Voltage drop check** — both assessed the same way: is there a computed voltage drop result in the calculation documents, and is it ≤5%? Reports the actual value found.
  - **Specs → all deliverables alignment** — flags a clear, quotable numeric or descriptive conflict between the spec and the other documents; only fires when it can quote the actual discrepancy.
  - The other five items (Revit coordination/health, Revit→BOQ quantity/geometry reconciliation, Drawing→Revit alignment, and the QA/QC sign-off) are intentionally **not** attempted by the AI — no clash detection, no geometry/quantity reconciliation. They stay manual-only.
- Suggestions are never auto-saved. Each shows as a distinct "AI review" panel with a proposed status, confidence, reasoning, and quoted evidence — the checklist item's actual status is untouched until you click **Accept suggestion** (or just set the dropdown yourself, which dismisses the suggestion and counts as a manual entry).
- Once accepted, the item is tagged **AI-assisted** so it stays visually distinct from items a reviewer entered by hand — this persists in the database (`status_source` column), not just in the current browser session.
- Documents are read in full up to a size cap (50 MB by default — override with `MAX_INGEST_MB`; raise it if your hosting plan has the RAM to spare, since parsing a large PDF briefly needs memory well beyond the file's own size) and, for the calculation and specification categories, filtered down to keyword-relevant excerpts before being sent to the model — this keeps requests small and means a document with no relevant content (e.g. a lighting/lux calculation export with no voltage-drop data in it) is honestly reported as excluded rather than silently truncated. Any file that's missing, too large, unreadable, or has no relevant content is listed as excluded, with the reason, in a panel above the checklist after each run — the AI is instructed to say "insufficient evidence" rather than guess when a document it needs isn't available.

Not included yet: clash detection, BIM model health checks, and Revit-model/BOQ quantity or geometry reconciliation — these remain manual QC judgment calls.

## Deploying

The app is a plain Node/Express server plus a SQLite file, so it deploys to any Node host. Two things matter for a working deployment:

1. **Persistent storage for the database.** The container filesystem on Render and Railway is wiped on every restart/redeploy, so `data/qc-tracker.db` needs to live on a mounted persistent disk/volume instead of the app's own folder. Set the `DATA_DIR` environment variable to that mount path — the app already reads it (`server/db.js`).
2. **The `GEMINI_API_KEY` environment variable**, set on the host the same way as locally.

### AI Review in production

Uses the upload path described above — visitors attach the relevant PDFs through the browser for each review. There's no local KSRT folder on the deployed host, so that dev-only fallback simply never triggers there.

### Deploy to Render

This repo includes a `render.yaml` Blueprint.

1. Push this repo to GitHub.
2. In the Render dashboard: **New** → **Blueprint**, and select the repo. Render reads `render.yaml` and provisions a web service with a 1 GB persistent disk mounted at `/var/data`.
3. When prompted, set the `GEMINI_API_KEY` secret (marked `sync: false` in the blueprint, so Render asks for it rather than storing it in the file).
4. Deploy. Render's persistent disks require the **Starter** plan or higher — the free plan doesn't support attaching a disk, so the database would not survive a redeploy on it.

### Deploy to Railway

Railway doesn't need a config file — it auto-detects the Node app from `package.json`.

1. Push this repo to GitHub.
2. In Railway: **New Project** → **Deploy from GitHub repo**, and select it.
3. Add a **Volume** to the service (Railway dashboard → the service → **Volumes** → **New Volume**), mounted at e.g. `/data`.
4. Set environment variables on the service: `GEMINI_API_KEY`, and `DATA_DIR=/data` (matching the volume's mount path). Railway injects `PORT` automatically — no need to set it.
5. Deploy. Railway generates a public URL for the service under **Settings** → **Networking** → **Generate Domain**.
