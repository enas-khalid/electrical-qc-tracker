const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { CHECKLIST_TEMPLATE } = require("./checklistItems");

// In production, point DATA_DIR at a mounted persistent disk/volume so the
// database survives restarts and redeploys — the container filesystem itself
// is ephemeral on both Render and Railway.
const dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "qc-tracker.db"));

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_name TEXT NOT NULL,
    riba_stage TEXT NOT NULL,
    submission_date TEXT NOT NULL,
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS checklist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    item_key TEXT NOT NULL,
    item_label TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'Not Applicable',
    note TEXT DEFAULT ''
  );
`);

// Lightweight migration: add AI-review columns if this is an existing DB from Part 1.
const checklistColumns = db.prepare(`PRAGMA table_info(checklist_items)`).all().map((c) => c.name);
const submissionColumns = db.prepare(`PRAGMA table_info(submissions)`).all().map((c) => c.name);

function addColumnIfMissing(table, existingColumns, column, definition) {
  if (!existingColumns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing("checklist_items", checklistColumns, "status_source", "TEXT NOT NULL DEFAULT 'manual'");
addColumnIfMissing("checklist_items", checklistColumns, "ai_suggested_status", "TEXT");
addColumnIfMissing("checklist_items", checklistColumns, "ai_confidence", "TEXT");
addColumnIfMissing("checklist_items", checklistColumns, "ai_finding", "TEXT");
addColumnIfMissing("checklist_items", checklistColumns, "ai_evidence", "TEXT");
addColumnIfMissing("checklist_items", checklistColumns, "ai_reviewed_at", "TEXT");
addColumnIfMissing("submissions", submissionColumns, "last_ai_review_at", "TEXT");

function createSubmission({ project_name, riba_stage, submission_date, notes }) {
  const insertSubmission = db.prepare(
    `INSERT INTO submissions (project_name, riba_stage, submission_date, notes) VALUES (?, ?, ?, ?)`
  );
  const result = insertSubmission.run(project_name, riba_stage, submission_date, notes || "");
  const submissionId = Number(result.lastInsertRowid);

  const insertItem = db.prepare(
    `INSERT INTO checklist_items (submission_id, item_key, item_label, sort_order, status, note) VALUES (?, ?, ?, ?, 'Not Applicable', '')`
  );
  CHECKLIST_TEMPLATE.forEach((item, index) => {
    insertItem.run(submissionId, item.key, item.label, index);
  });

  return submissionId;
}

function listSubmissions() {
  const submissions = db
    .prepare(`SELECT * FROM submissions ORDER BY submission_date DESC, id DESC`)
    .all();

  const mismatchCounts = db
    .prepare(
      `SELECT submission_id, COUNT(*) as count FROM checklist_items WHERE status = 'Mismatch Found' GROUP BY submission_id`
    )
    .all();
  const mismatchMap = new Map(mismatchCounts.map((row) => [row.submission_id, row.count]));

  const itemCounts = db
    .prepare(`SELECT submission_id, COUNT(*) as count FROM checklist_items GROUP BY submission_id`)
    .all();
  const itemCountMap = new Map(itemCounts.map((row) => [row.submission_id, row.count]));

  return submissions.map((s) => ({
    ...s,
    mismatch_count: mismatchMap.get(s.id) || 0,
    checklist_total: itemCountMap.get(s.id) || 0,
  }));
}

function getSubmission(id) {
  const submission = db.prepare(`SELECT * FROM submissions WHERE id = ?`).get(id);
  if (!submission) return null;
  const items = db
    .prepare(`SELECT * FROM checklist_items WHERE submission_id = ? ORDER BY sort_order ASC`)
    .all(id);
  return { ...submission, checklist_items: items };
}

function updateSubmission(id, { project_name, riba_stage, submission_date, notes }) {
  db.prepare(
    `UPDATE submissions SET project_name = ?, riba_stage = ?, submission_date = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(project_name, riba_stage, submission_date, notes || "", id);
}

function deleteSubmission(id) {
  db.prepare(`DELETE FROM submissions WHERE id = ?`).run(id);
}

// Manual edit path: the user typed a status/note directly (with or without ever
// seeing an AI suggestion). Clears any pending suggestion and records manual provenance.
function updateChecklistItem(itemId, { status, note }) {
  db.prepare(
    `UPDATE checklist_items
     SET status = ?, note = ?, status_source = 'manual',
         ai_suggested_status = NULL, ai_confidence = NULL, ai_finding = NULL, ai_evidence = NULL
     WHERE id = ?`
  ).run(status, note || "", itemId);
}

// AI review path: stash a proposed status + reasoning without touching the saved status/note.
function setAiSuggestion(itemId, { suggested_status, confidence, finding, evidence }) {
  db.prepare(
    `UPDATE checklist_items
     SET ai_suggested_status = ?, ai_confidence = ?, ai_finding = ?, ai_evidence = ?, ai_reviewed_at = datetime('now')
     WHERE id = ?`
  ).run(suggested_status, confidence, finding, evidence, itemId);
}

// User clicks Accept: the suggested status becomes the real, saved result.
function acceptAiSuggestion(itemId) {
  const item = db.prepare(`SELECT * FROM checklist_items WHERE id = ?`).get(itemId);
  if (!item || !item.ai_suggested_status) return null;
  db.prepare(
    `UPDATE checklist_items
     SET status = ?, status_source = 'ai_accepted',
         ai_suggested_status = NULL, ai_confidence = NULL, ai_finding = NULL, ai_evidence = NULL
     WHERE id = ?`
  ).run(item.ai_suggested_status, itemId);
  return getChecklistItem(itemId);
}

// User dismisses a suggestion without accepting it or changing the status.
function dismissAiSuggestion(itemId) {
  db.prepare(
    `UPDATE checklist_items
     SET ai_suggested_status = NULL, ai_confidence = NULL, ai_finding = NULL, ai_evidence = NULL
     WHERE id = ?`
  ).run(itemId);
}

function getChecklistItem(itemId) {
  return db.prepare(`SELECT * FROM checklist_items WHERE id = ?`).get(itemId);
}

function touchLastAiReview(submissionId) {
  db.prepare(`UPDATE submissions SET last_ai_review_at = datetime('now') WHERE id = ?`).run(submissionId);
}

module.exports = {
  db,
  createSubmission,
  listSubmissions,
  getSubmission,
  updateSubmission,
  deleteSubmission,
  updateChecklistItem,
  setAiSuggestion,
  acceptAiSuggestion,
  dismissAiSuggestion,
  getChecklistItem,
  touchLastAiReview,
};
