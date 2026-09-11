try {
  process.loadEnvFile();
} catch {
  // No .env file present — that's fine, GEMINI_API_KEY may already be set in the environment.
}

const path = require("node:path");
const express = require("express");
const multer = require("multer");
const {
  createSubmission,
  listSubmissions,
  getSubmission,
  updateSubmission,
  deleteSubmission,
  updateChecklistItem,
  setAiSuggestion,
  acceptAiSuggestion,
  dismissAiSuggestion,
  touchLastAiReview,
} = require("./db");
const { STATUS_VALUES } = require("./checklistItems");
const { runAiReview } = require("./aiReview");
const { loadLocalDocumentSet, loadUploadedDocumentSet, hasAnyUploads, MAX_INGEST_BYTES } = require("./ksrtDocuments");

// Files are held in memory only for the duration of one review request, never
// written to disk — this is what makes the upload path work on a host with no
// writable/persistent filesystem for arbitrary files.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_INGEST_BYTES },
});
const reviewUpload = upload.fields([
  { name: "calculation", maxCount: 5 },
  { name: "boq", maxCount: 3 },
  { name: "specs", maxCount: 3 },
  { name: "reference", maxCount: 3 },
]);

const RIBA_STAGES = [
  "Stage 0 — Strategic Definition",
  "Stage 1 — Preparation and Briefing",
  "Stage 2 — Concept Design",
  "Stage 3 — Spatial Coordination",
  "Stage 4 — Technical Design",
  "Stage 5 — Manufacturing and Construction",
  "Stage 6 — Handover",
  "Stage 7 — Use",
];

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

function validateSubmissionPayload(body) {
  const errors = [];
  if (!body.project_name || !String(body.project_name).trim()) {
    errors.push("Project name is required.");
  }
  if (!body.riba_stage || !RIBA_STAGES.includes(body.riba_stage)) {
    errors.push("A valid RIBA stage is required.");
  }
  if (!body.submission_date || isNaN(Date.parse(body.submission_date))) {
    errors.push("A valid submission date is required.");
  }
  return errors;
}

app.get("/api/riba-stages", (req, res) => {
  res.json(RIBA_STAGES);
});

app.get("/api/submissions", (req, res) => {
  res.json(listSubmissions());
});

app.post("/api/submissions", (req, res) => {
  const errors = validateSubmissionPayload(req.body);
  if (errors.length) return res.status(400).json({ errors });

  const { project_name, riba_stage, submission_date, notes } = req.body;
  const id = createSubmission({
    project_name: String(project_name).trim(),
    riba_stage,
    submission_date,
    notes: notes ? String(notes) : "",
  });
  res.status(201).json(getSubmission(id));
});

app.get("/api/submissions/:id", (req, res) => {
  const submission = getSubmission(Number(req.params.id));
  if (!submission) return res.status(404).json({ errors: ["Submission not found."] });
  res.json(submission);
});

app.put("/api/submissions/:id", (req, res) => {
  const id = Number(req.params.id);
  const existing = getSubmission(id);
  if (!existing) return res.status(404).json({ errors: ["Submission not found."] });

  const errors = validateSubmissionPayload(req.body);
  if (errors.length) return res.status(400).json({ errors });

  const { project_name, riba_stage, submission_date, notes } = req.body;
  updateSubmission(id, {
    project_name: String(project_name).trim(),
    riba_stage,
    submission_date,
    notes: notes ? String(notes) : "",
  });
  res.json(getSubmission(id));
});

app.delete("/api/submissions/:id", (req, res) => {
  const id = Number(req.params.id);
  const existing = getSubmission(id);
  if (!existing) return res.status(404).json({ errors: ["Submission not found."] });
  deleteSubmission(id);
  res.status(204).end();
});

app.put("/api/checklist-items/:id", (req, res) => {
  const id = Number(req.params.id);
  const { status, note } = req.body;
  if (!STATUS_VALUES.includes(status)) {
    return res.status(400).json({ errors: [`Status must be one of: ${STATUS_VALUES.join(", ")}`] });
  }
  updateChecklistItem(id, { status, note: note ? String(note) : "" });
  res.json({ ok: true });
});

app.post("/api/submissions/:id/ai-review", (req, res) => {
  reviewUpload(req, res, async (uploadErr) => {
    if (uploadErr) {
      const message =
        uploadErr instanceof multer.MulterError && uploadErr.code === "LIMIT_FILE_SIZE"
          ? `A file is larger than the ${(MAX_INGEST_BYTES / (1024 * 1024)).toFixed(0)} MB upload limit.`
          : uploadErr.message;
      return res.status(400).json({ errors: [message] });
    }

    const id = Number(req.params.id);
    const submission = getSubmission(id);
    if (!submission) return res.status(404).json({ errors: ["Submission not found."] });

    if (!process.env.GEMINI_API_KEY) {
      return res.status(400).json({
        errors: [
          "GEMINI_API_KEY is not set. Add it to a .env file in the project root (GEMINI_API_KEY=...) or set it as an environment variable, then restart the server. Get a key from Google AI Studio: https://aistudio.google.com/apikey",
        ],
      });
    }

    try {
      const usingUploads = hasAnyUploads(req.files);
      const documentSet = usingUploads ? await loadUploadedDocumentSet(req.files) : await loadLocalDocumentSet();

      const result = await runAiReview(submission, documentSet);
      const itemsByKey = new Map(submission.checklist_items.map((item) => [item.item_key, item]));

      for (const suggestion of result.suggestions) {
        const item = itemsByKey.get(suggestion.item_key);
        if (!item) continue;
        setAiSuggestion(item.id, {
          suggested_status: suggestion.has_suggestion ? suggestion.suggested_status : null,
          confidence: suggestion.confidence,
          finding: suggestion.finding,
          evidence: suggestion.evidence,
        });
      }
      touchLastAiReview(id);

      res.json({
        submission: getSubmission(id),
        documentSource: usingUploads ? "uploaded" : "local-folder",
        documentsConsidered: result.documentsConsidered,
        documentsExcluded: result.documentsExcluded,
      });
    } catch (err) {
      console.error("AI review failed:", err);
      res.status(502).json({ errors: [`AI review failed: ${err.message}`] });
    }
  });
});

app.post("/api/checklist-items/:id/accept-ai-suggestion", (req, res) => {
  const id = Number(req.params.id);
  const updated = acceptAiSuggestion(id);
  if (!updated) {
    return res.status(400).json({ errors: ["No pending AI suggestion for this checklist item."] });
  }
  res.json(updated);
});

app.post("/api/checklist-items/:id/dismiss-ai-suggestion", (req, res) => {
  const id = Number(req.params.id);
  dismissAiSuggestion(id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 4173;
app.listen(PORT, () => {
  console.log(`Electrical Submission QC Tracker running at http://localhost:${PORT}`);
});
