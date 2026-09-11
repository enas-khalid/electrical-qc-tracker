const fs = require("node:fs");
const path = require("node:path");
const pdfParse = require("pdf-parse");

// Local-dev fallback only: when no files are uploaded through the browser,
// the app looks for the KSRT project files one level above this app folder.
// This path does not exist on a deployed host, and that's expected — see
// loadUploadedDocumentSet below for the path that works there.
const PROJECT_ROOT = path.join(__dirname, "..", "..");

// Documents big enough to blow the model's per-request budget (or a modest
// hosting plan's RAM while parsing) are excluded rather than silently
// truncated or risking an out-of-memory crash. Configurable because the right
// number depends on how much RAM the host actually has — bump it via
// MAX_INGEST_MB if you upgrade the hosting plan and need bigger files.
const MAX_INGEST_BYTES = Number(process.env.MAX_INGEST_MB || 50) * 1024 * 1024;

// Which categories get full text vs. keyword-filtered excerpts. Calculation
// exports and specs can run to hundreds of pages (per-room lux grids, or
// every discipline's spec section) — keyword-excerpting keeps the request
// small and, when a document genuinely has no relevant content, surfaces
// that honestly instead of truncating to whatever's on its first pages.
const CATEGORY_CONFIG = {
  calculation: { excerptOnly: true },
  boq: { excerptOnly: false },
  specs: { excerptOnly: true },
  reference: { excerptOnly: false },
};

const LOCAL_DOCUMENT_REGISTRY = {
  calculation: [
    {
      label: "Emergency Lighting Calculations",
      file: path.join(PROJECT_ROOT, "Electrical", "211.24-EHAF-EL-XX-EMERGENCY LIGHTING CALCULATIONS.pdf"),
    },
    {
      label: "Normal Lighting Calculations",
      file: path.join(PROJECT_ROOT, "Electrical", "211.24-EHAF-EL-XX-NORMAL LIGHTING CALCULATIONS.pdf"),
    },
  ],
  boq: [
    {
      label: "Bill of Quantities",
      file: path.join(PROJECT_ROOT, "211.24-EHAF-ZZ-XX-Bill of Quantities-00.pdf"),
    },
  ],
  specs: [
    {
      label: "Electrical Specifications",
      file: path.join(PROJECT_ROOT, "electrical specs", "211.24-EHAF-EL-XX-Specifications.pdf"),
    },
  ],
  reference: [
    {
      label: "Electrical Concept Design Report",
      file: path.join(PROJECT_ROOT, "211.24-EHAF-EL-XX-ELECTRICAL CONCEPT REPORT.pdf"),
    },
  ],
};

const EXCERPT_KEYWORDS = [
  "voltage drop",
  "power factor",
  "busway",
  "cable siz",
  "conductor siz",
  "demand factor",
  "diversity factor",
  "load density",
  "quantity",
  "distribution board",
  "cross-sectional",
  "cross sectional",
];
const EXCERPT_MAX_CHARS = 60000;
const FULL_TEXT_MAX_CHARS = 120000;

function extractRelevantExcerpts(text, keywords, maxChars) {
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  const picked = [];
  let total = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 20) continue;
    const lower = trimmed.toLowerCase();
    if (!keywords.some((k) => lower.includes(k))) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    if (total + trimmed.length > maxChars) break;
    picked.push(trimmed);
    total += trimmed.length;
  }

  return picked.join("\n---\n");
}

// Turns one PDF buffer into either an included doc (label, page count, text)
// or an excluded entry (label, reason) — the single code path used for both
// locally-read files and browser-uploaded files, so they're reviewed identically.
async function processPdfBuffer(label, buffer, { excerptOnly }) {
  const sizeBytes = buffer.length;
  if (sizeBytes > MAX_INGEST_BYTES) {
    const mb = (sizeBytes / (1024 * 1024)).toFixed(1);
    return {
      status: "excluded",
      label,
      reason: `File is ${mb} MB — too large for automated review (limit ${(MAX_INGEST_BYTES / (1024 * 1024)).toFixed(0)} MB). Please review manually.`,
    };
  }

  try {
    const parsed = await pdfParse(buffer);
    let text = parsed.text || "";
    if (excerptOnly) {
      text = extractRelevantExcerpts(text, EXCERPT_KEYWORDS, EXCERPT_MAX_CHARS);
      if (!text) {
        return {
          status: "excluded",
          label,
          reason: "No sections matching relevant keywords (voltage drop, cable sizing, quantities, etc.) were found.",
        };
      }
    } else if (text.length > FULL_TEXT_MAX_CHARS) {
      text = text.slice(0, FULL_TEXT_MAX_CHARS);
    }
    return { status: "included", label, pages: parsed.numpages, text };
  } catch (err) {
    return { status: "excluded", label, reason: `Could not read file: ${err.message}` };
  }
}

function splitResults(results) {
  const included = [];
  const excluded = [];
  for (const r of results) {
    if (r.status === "included") included.push({ label: r.label, pages: r.pages, text: r.text });
    else excluded.push({ label: r.label, reason: r.reason });
  }
  return { included, excluded };
}

function statFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { exists: true, size: stat.size };
  } catch {
    return { exists: false, size: 0 };
  }
}

async function loadLocalCategory(entries, { excerptOnly }) {
  const results = [];
  for (const entry of entries) {
    const { exists } = statFile(entry.file);
    if (!exists) {
      results.push({ status: "excluded", label: entry.label, reason: "File not found in the KSRT project folder." });
      continue;
    }
    const buffer = fs.readFileSync(entry.file);
    results.push(await processPdfBuffer(entry.label, buffer, { excerptOnly }));
  }
  return splitResults(results);
}

// Local-dev fallback: reads the KSRT project files from disk, one level above
// this app folder. Does nothing useful on a deployed host — see loadUploadedDocumentSet.
async function loadLocalDocumentSet() {
  const [calculation, boq, specs, reference] = await Promise.all([
    loadLocalCategory(LOCAL_DOCUMENT_REGISTRY.calculation, CATEGORY_CONFIG.calculation),
    loadLocalCategory(LOCAL_DOCUMENT_REGISTRY.boq, CATEGORY_CONFIG.boq),
    loadLocalCategory(LOCAL_DOCUMENT_REGISTRY.specs, CATEGORY_CONFIG.specs),
    loadLocalCategory(LOCAL_DOCUMENT_REGISTRY.reference, CATEGORY_CONFIG.reference),
  ]);
  return { calculation, boq, specs, reference };
}

// The path that works everywhere, including deployed hosts with no access to
// the user's local filesystem: `uploads` is { calculation: [{originalname, buffer}], boq: [...], ... }
// as produced by multer from the "Run AI Review" upload form.
async function loadUploadedDocumentSet(uploads) {
  const categories = ["calculation", "boq", "specs", "reference"];
  const entries = await Promise.all(
    categories.map(async (category) => {
      const files = uploads?.[category] || [];
      const { excerptOnly } = CATEGORY_CONFIG[category];
      const results = await Promise.all(
        files.map((f) => processPdfBuffer(f.originalname, f.buffer, { excerptOnly }))
      );
      return [category, splitResults(results)];
    })
  );
  return Object.fromEntries(entries);
}

function hasAnyUploads(uploads) {
  if (!uploads) return false;
  return ["calculation", "boq", "specs", "reference"].some((c) => (uploads[c] || []).length > 0);
}

module.exports = {
  loadLocalDocumentSet,
  loadUploadedDocumentSet,
  hasAnyUploads,
  MAX_INGEST_BYTES,
};
