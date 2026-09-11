const { GoogleGenAI } = require("@google/genai");
const { z } = require("zod");
const { zodToJsonSchema } = require("zod-to-json-schema");

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-pro-preview";

// The three checklist items the AI is allowed to weigh in on. Everything else
// (clash-free coordination, BIM health, Revit->BOQ quantity/geometry reconciliation,
// and the human QA/QC sign-off) is explicitly out of scope — see the requirements
// this feature was built against: no clash detection, no geometry/quantity reconciliation.
const APPLICABLE_ITEM_KEYS = ["calc_drawing", "voltage_drop", "specs_deliverables"];

// "None" is used instead of a nullable field: Gemini's structured-output JSON
// schema support does not reliably handle JSON Schema `anyOf`/`type: null`
// unions, so we keep every field a plain enum/string and translate below.
const SuggestionSchema = z.object({
  item_key: z.enum(APPLICABLE_ITEM_KEYS),
  has_suggestion: z
    .boolean()
    .describe("False if the available documents do not contain clear enough evidence to propose a status."),
  suggested_status: z
    .enum(["Checked", "Mismatch Found", "Not Applicable", "None"])
    .describe('"None" when has_suggestion is false.'),
  confidence: z.enum(["low", "medium", "high"]),
  finding: z
    .string()
    .describe("1-3 sentences: what was assessed and the conclusion. If has_suggestion is false, explain what's missing."),
  evidence: z
    .string()
    .describe("Direct quotes or specific values from the documents that support the finding. Empty string if none."),
});

const ReviewSchema = z.object({
  suggestions: z.array(SuggestionSchema).length(APPLICABLE_ITEM_KEYS.length),
});

const RESPONSE_JSON_SCHEMA = (() => {
  const schema = zodToJsonSchema(ReviewSchema, { $refStrategy: "none" });
  delete schema.$schema;
  return schema;
})();

function formatIncluded(category) {
  if (category.included.length === 0) return "  (none included)";
  return category.included
    .map((doc) => `  --- ${doc.label} (${doc.pages} pages) ---\n${doc.text}`)
    .join("\n\n");
}

function formatExcluded(allCategories) {
  const lines = [];
  for (const category of allCategories) {
    for (const doc of category.excluded) {
      lines.push(`  - ${doc.label}: ${doc.reason}`);
    }
  }
  return lines.length ? lines.join("\n") : "  (none)";
}

function buildPrompt(submission, documentSet) {
  const { calculation, boq, specs, reference } = documentSet;

  const system = `You are assisting an electrical QC reviewer at EHAF Consulting Engineers on the KSRT electrical submission checklist. You will be shown excerpts from the project's calculation, BOQ, specification, and concept-design documents.

For exactly these three checklist items, decide whether the documents give you clear enough evidence to propose a status:
- calc_drawing ("Calculation → Drawing alignment") and voltage_drop ("Voltage drop check, must be ≤5%"): both are judged the same way — find the calculated voltage drop result in the calculation documents and assess whether it is technically correct and within the 5% code limit. Report the actual value found.
- specs_deliverables ("Specs → all deliverables alignment"): look for a clear, quotable numeric or descriptive conflict between the specification and the other documents (BOQ, concept report, calculations) — e.g. a cable standard, rating, or limit stated differently in two places. Only flag it if you can quote the specific discrepancy.

Rules:
- Never guess or extrapolate. If a document needed for an item is missing, excluded, or simply doesn't contain a clear answer, set has_suggestion to false, set suggested_status to "None", and say what's missing — do not force a status.
- Only claim "Mismatch Found" when you can quote the conflicting text or values as evidence.
- Do not attempt clash detection, BIM model health, or Revit-model/BOQ quantity or geometry reconciliation — those items are not in your scope and are not part of this request.
- Ground every finding in the document text provided; do not rely on general engineering knowledge for facts specific to this project.
- Respond with JSON only, matching the provided schema exactly.`;

  const user = `Submission under review:
- Project: ${submission.project_name}
- RIBA stage: ${submission.riba_stage}
- Submission date: ${submission.submission_date}
- Notes: ${submission.notes || "(none)"}

=== CALCULATION DOCUMENTS ===
${formatIncluded(calculation)}

=== BILL OF QUANTITIES ===
${formatIncluded(boq)}

=== SPECIFICATION EXCERPTS (keyword-matched, not the full document) ===
${formatIncluded(specs)}

=== CONCEPT DESIGN REPORT ===
${formatIncluded(reference)}

=== DOCUMENTS EXCLUDED FROM THIS REVIEW ===
${formatExcluded([calculation, boq, specs, reference])}

Produce one suggestion object for each of: calc_drawing, voltage_drop, specs_deliverables.`;

  return { system, user };
}

// documentSet is built by the caller — either from uploaded files (production,
// and local dev when the user chooses to upload) or from the local KSRT folder
// (local-dev fallback only) — see server/ksrtDocuments.js.
async function runAiReview(submission, documentSet) {
  const { system, user } = buildPrompt(submission, documentSet);

  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const response = await client.models.generateContent({
    model: GEMINI_MODEL,
    contents: user,
    config: {
      systemInstruction: system,
      responseMimeType: "application/json",
      responseJsonSchema: RESPONSE_JSON_SCHEMA,
    },
  });

  const raw = response.text;
  if (!raw) {
    throw new Error("The model returned an empty response.");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`The model response was not valid JSON: ${err.message}`);
  }

  const result = ReviewSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`The model response did not match the expected structure: ${result.error.message}`);
  }

  // Translate the "None" sentinel back to null for the rest of the app.
  const suggestions = result.data.suggestions.map((s) => ({
    ...s,
    suggested_status: s.suggested_status === "None" ? null : s.suggested_status,
  }));

  const documentsConsidered = [];
  const documentsExcluded = [];
  for (const category of [documentSet.calculation, documentSet.boq, documentSet.specs, documentSet.reference]) {
    for (const doc of category.included) documentsConsidered.push(doc.label);
    for (const doc of category.excluded) documentsExcluded.push({ label: doc.label, reason: doc.reason });
  }

  return { suggestions, documentsConsidered, documentsExcluded };
}

module.exports = { runAiReview, APPLICABLE_ITEM_KEYS };
