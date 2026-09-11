const STATUS_VALUES = ["Checked", "Mismatch Found", "Not Applicable"];

// Mirrors server/aiReview.js APPLICABLE_ITEM_KEYS — the only items the AI is
// allowed to weigh in on. Clash detection, BIM health, Revit/BOQ geometry
// reconciliation, and the human sign-off are manual-only by design.
const AI_APPLICABLE_KEYS = ["calc_drawing", "voltage_drop", "specs_deliverables"];

const state = {
  submissions: [],
  ribaStages: [],
  currentSubmissionId: null,
};

const el = (id) => document.getElementById(id);

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body.errors && body.errors.join(" ")) || "Request failed.";
    throw new Error(message);
  }
  return body;
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function statusBadgeClass(status) {
  if (status === "Checked") return "status-badge--checked";
  if (status === "Mismatch Found") return "status-badge--mismatch";
  return "status-badge--na";
}

function checklistSummaryBadge(sub) {
  if (sub.mismatch_count > 0) {
    return `<span class="status-badge status-badge--mismatch"><span class="status-badge__dot"></span>${sub.mismatch_count} mismatch${sub.mismatch_count > 1 ? "es" : ""} found</span>`;
  }
  return `<span class="status-badge status-badge--checked"><span class="status-badge__dot"></span>No mismatches</span>`;
}

/* ---------------------------------------------------------------------- */
/* View switching                                                          */
/* ---------------------------------------------------------------------- */
function showDashboard() {
  el("view-detail").hidden = true;
  el("view-dashboard").hidden = false;
  state.currentSubmissionId = null;
  loadSubmissions();
}

function showDetail(id) {
  state.currentSubmissionId = id;
  el("view-dashboard").hidden = true;
  el("view-detail").hidden = false;
  el("ai-documents-panel").hidden = true;
  ["upload-calculation", "upload-boq", "upload-specs", "upload-reference"].forEach((inputId) => {
    el(inputId).value = "";
  });
  loadSubmissionDetail(id);
}

/* ---------------------------------------------------------------------- */
/* Dashboard                                                               */
/* ---------------------------------------------------------------------- */
async function loadSubmissions() {
  const submissions = await api("/api/submissions");
  state.submissions = submissions;
  renderSummaryMetrics(submissions);
  renderSubmissionsTable(submissions);
}

function renderSummaryMetrics(submissions) {
  const total = submissions.length;
  const totalMismatches = submissions.reduce((sum, s) => sum + s.mismatch_count, 0);
  const submissionsWithMismatches = submissions.filter((s) => s.mismatch_count > 0).length;
  const clean = total - submissionsWithMismatches;

  el("summary-metrics").innerHTML = `
    <div class="metric-card">
      <div class="metric-card__value">${total}</div>
      <div class="metric-card__label">Total submissions</div>
    </div>
    <div class="metric-card">
      <div class="metric-card__value ${totalMismatches > 0 ? "metric-card__value--risk" : ""}">${totalMismatches}</div>
      <div class="metric-card__label">Open mismatches</div>
    </div>
    <div class="metric-card">
      <div class="metric-card__value">${clean}</div>
      <div class="metric-card__label">Clean submissions</div>
    </div>
  `;
}

function renderSubmissionsTable(submissions) {
  const tbody = el("submissions-tbody");
  el("submissions-empty").hidden = submissions.length > 0;
  el("submissions-table").hidden = submissions.length === 0;

  tbody.innerHTML = submissions
    .map(
      (s) => `
      <tr data-id="${s.id}">
        <td><a class="data-table__row-link" data-open="${s.id}">${escapeHtml(s.project_name)}</a></td>
        <td>${escapeHtml(s.riba_stage)}</td>
        <td>${formatDate(s.submission_date)}</td>
        <td>${checklistSummaryBadge(s)}</td>
        <td class="align-right">
          <button class="btn btn--text btn--sm" data-open="${s.id}">Open</button>
          <button class="btn btn--text btn--sm" data-delete="${s.id}" style="color:var(--status-red)">Delete</button>
        </td>
      </tr>`
    )
    .join("");

  tbody.querySelectorAll("[data-open]").forEach((btn) => {
    btn.addEventListener("click", () => showDetail(Number(btn.dataset.open)));
  });
  tbody.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", () => handleDeleteSubmission(Number(btn.dataset.delete)));
  });
}

async function handleDeleteSubmission(id) {
  const submission = state.submissions.find((s) => s.id === id);
  const label = submission ? `${submission.project_name} — ${submission.riba_stage}` : `#${id}`;
  if (!confirm(`Delete submission "${label}" and its checklist? This cannot be undone.`)) return;
  await api(`/api/submissions/${id}`, { method: "DELETE" });
  loadSubmissions();
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

/* ---------------------------------------------------------------------- */
/* RIBA stage options                                                      */
/* ---------------------------------------------------------------------- */
function populateRibaSelect(selectEl) {
  selectEl.innerHTML = state.ribaStages.map((stage) => `<option value="${escapeHtml(stage)}">${escapeHtml(stage)}</option>`).join("");
}

/* ---------------------------------------------------------------------- */
/* New submission modal                                                    */
/* ---------------------------------------------------------------------- */
function openNewModal() {
  el("form-new-submission").reset();
  el("new-project-name").value = "KSRT";
  populateRibaSelect(el("new-riba-stage"));
  el("new-submission-date").value = new Date().toISOString().slice(0, 10);
  el("new-submission-errors").hidden = true;
  el("modal-new").hidden = false;
}

function closeNewModal() {
  el("modal-new").hidden = true;
}

async function handleCreateSubmission(evt) {
  evt.preventDefault();
  const payload = {
    project_name: el("new-project-name").value,
    riba_stage: el("new-riba-stage").value,
    submission_date: el("new-submission-date").value,
    notes: el("new-notes").value,
  };
  try {
    const created = await api("/api/submissions", { method: "POST", body: JSON.stringify(payload) });
    closeNewModal();
    showDetail(created.id);
  } catch (err) {
    el("new-submission-errors").textContent = err.message;
    el("new-submission-errors").hidden = false;
  }
}

/* ---------------------------------------------------------------------- */
/* Submission detail view                                                  */
/* ---------------------------------------------------------------------- */
async function loadSubmissionDetail(id) {
  const submission = await api(`/api/submissions/${id}`);
  populateRibaSelect(el("detail-riba-stage"));

  el("detail-eyebrow").textContent = submission.riba_stage;
  el("detail-title").textContent = submission.project_name;
  el("detail-subtitle").textContent = `Submitted ${formatDate(submission.submission_date)}`;

  el("detail-project-name").value = submission.project_name;
  el("detail-riba-stage").value = submission.riba_stage;
  el("detail-submission-date").value = submission.submission_date;
  el("detail-notes").value = submission.notes || "";
  el("meta-save-status").textContent = "";

  el("ai-review-status").textContent = submission.last_ai_review_at
    ? `Last AI review: ${formatDateTime(submission.last_ai_review_at)}`
    : "";

  renderChecklist(submission.checklist_items);
}

function formatDateTime(sqlTimestamp) {
  // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" in UTC.
  const d = new Date(sqlTimestamp.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return sqlTimestamp;
  return d.toLocaleString();
}

function renderChecklist(items) {
  const list = el("checklist-list");
  list.innerHTML = items.map((item) => renderChecklistCard(item)).join("");

  list.querySelectorAll(".checklist-status").forEach((sel) => {
    sel.addEventListener("change", () => saveChecklistItem(sel.dataset.itemId));
  });
  list.querySelectorAll(".checklist-note-input").forEach((ta) => {
    ta.addEventListener("blur", () => saveChecklistItem(ta.dataset.itemId));
  });
  list.querySelectorAll("[data-accept-suggestion]").forEach((btn) => {
    btn.addEventListener("click", () => acceptSuggestion(btn.dataset.acceptSuggestion));
  });
  list.querySelectorAll("[data-dismiss-suggestion]").forEach((btn) => {
    btn.addEventListener("click", () => dismissSuggestion(btn.dataset.dismissSuggestion));
  });
}

function renderChecklistCard(item) {
  const isAiApplicable = AI_APPLICABLE_KEYS.includes(item.item_key);
  const manualTag = !isAiApplicable
    ? `<span class="checklist-item-card__manual-tag">Manual review only</span>`
    : "";
  const sourceTag =
    item.status_source === "ai_accepted"
      ? `<span class="status-source-tag">AI-assisted</span>`
      : "";

  return `
    <div class="checklist-item-card" data-item-id="${item.id}">
      <div class="checklist-item-card__header">
        <div class="checklist-item-card__title">${escapeHtml(item.item_label)}</div>
        <div class="flex gap-2 align-center">${sourceTag}${manualTag}</div>
      </div>
      <div class="checklist-item-card__controls">
        <select class="select checklist-status" data-item-id="${item.id}">
          ${STATUS_VALUES.map(
            (v) => `<option value="${v}" ${v === item.status ? "selected" : ""}>${v}</option>`
          ).join("")}
        </select>
        <textarea class="textarea checklist-note-input" data-item-id="${item.id}" placeholder="Note (optional)">${escapeHtml(item.note)}</textarea>
      </div>
      ${renderAiSuggestion(item)}
    </div>`;
}

function renderAiSuggestion(item) {
  if (!item.ai_finding) return "";

  const hasSuggestion = !!item.ai_suggested_status;
  const badgeClass = hasSuggestion ? statusBadgeClass(item.ai_suggested_status) : "status-badge--neutral";
  const suggestedLabel = hasSuggestion
    ? `<span class="status-badge ${badgeClass}"><span class="status-badge__dot"></span>Suggested: ${escapeHtml(item.ai_suggested_status)}</span>`
    : `<span class="status-badge status-badge--neutral"><span class="status-badge__dot"></span>No suggestion</span>`;

  const actions = hasSuggestion
    ? `<div class="ai-suggestion__actions">
         <button class="btn btn--primary btn--sm" data-accept-suggestion="${item.id}">Accept suggestion</button>
         <button class="btn btn--text btn--sm" data-dismiss-suggestion="${item.id}">Dismiss</button>
       </div>`
    : `<div class="ai-suggestion__actions">
         <button class="btn btn--text btn--sm" data-dismiss-suggestion="${item.id}">Dismiss</button>
       </div>`;

  return `
    <div class="ai-suggestion">
      <div class="ai-suggestion__header">
        <span class="ai-suggestion__badge">AI review</span>
        ${suggestedLabel}
        <span class="ai-suggestion__confidence">Confidence: ${escapeHtml(item.ai_confidence || "—")}</span>
      </div>
      <div class="ai-suggestion__finding">${escapeHtml(item.ai_finding)}</div>
      ${item.ai_evidence ? `<div class="ai-suggestion__evidence">${escapeHtml(item.ai_evidence)}</div>` : ""}
      ${actions}
    </div>`;
}

async function saveChecklistItem(itemId) {
  const card = document.querySelector(`.checklist-item-card[data-item-id="${itemId}"]`);
  const status = card.querySelector(".checklist-status").value;
  const note = card.querySelector(".checklist-note-input").value;
  await api(`/api/checklist-items/${itemId}`, { method: "PUT", body: JSON.stringify({ status, note }) });
  // Manual edits clear any pending AI suggestion server-side — refresh this card to reflect that.
  refreshChecklistCard(itemId);
}

async function acceptSuggestion(itemId) {
  await api(`/api/checklist-items/${itemId}/accept-ai-suggestion`, { method: "POST" });
  refreshChecklistCard(itemId);
}

async function dismissSuggestion(itemId) {
  await api(`/api/checklist-items/${itemId}/dismiss-ai-suggestion`, { method: "POST" });
  refreshChecklistCard(itemId);
}

async function refreshChecklistCard(itemId) {
  const submission = await api(`/api/submissions/${state.currentSubmissionId}`);
  const item = submission.checklist_items.find((i) => String(i.id) === String(itemId));
  if (!item) return;
  const card = document.querySelector(`.checklist-item-card[data-item-id="${itemId}"]`);
  card.outerHTML = renderChecklistCard(item);
  const newCard = document.querySelector(`.checklist-item-card[data-item-id="${itemId}"]`);
  newCard.querySelector(".checklist-status").addEventListener("change", () => saveChecklistItem(itemId));
  newCard.querySelector(".checklist-note-input").addEventListener("blur", () => saveChecklistItem(itemId));
  const acceptBtn = newCard.querySelector("[data-accept-suggestion]");
  if (acceptBtn) acceptBtn.addEventListener("click", () => acceptSuggestion(itemId));
  const dismissBtn = newCard.querySelector("[data-dismiss-suggestion]");
  if (dismissBtn) dismissBtn.addEventListener("click", () => dismissSuggestion(itemId));
}

function buildAiReviewFormData() {
  const formData = new FormData();
  const fields = [
    ["calculation", "upload-calculation"],
    ["boq", "upload-boq"],
    ["specs", "upload-specs"],
    ["reference", "upload-reference"],
  ];
  let fileCount = 0;
  for (const [fieldName, inputId] of fields) {
    const input = el(inputId);
    for (const file of input.files) {
      formData.append(fieldName, file);
      fileCount++;
    }
  }
  return { formData, fileCount };
}

async function handleRunAiReview() {
  const btn = el("btn-run-ai-review");
  const statusEl = el("ai-review-status");
  const { formData, fileCount } = buildAiReviewFormData();

  btn.disabled = true;
  btn.textContent = "Reviewing…";
  statusEl.textContent = fileCount > 0
    ? `Reading ${fileCount} uploaded document${fileCount > 1 ? "s" : ""}…`
    : "No files uploaded — reading the local KSRT folder (local development only)…";

  try {
    const res = await fetch(`/api/submissions/${state.currentSubmissionId}/ai-review`, {
      method: "POST",
      body: formData,
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error((result.errors && result.errors.join(" ")) || "Request failed.");
    }

    renderChecklist(result.submission.checklist_items);
    renderDocumentsPanel(result.documentSource, result.documentsConsidered, result.documentsExcluded);
    statusEl.textContent = result.submission.last_ai_review_at
      ? `Last AI review: ${formatDateTime(result.submission.last_ai_review_at)}`
      : "";
  } catch (err) {
    el("ai-documents-panel").hidden = false;
    el("ai-documents-panel").classList.add("callout--risk");
    el("ai-documents-panel").innerHTML = `<div class="callout__title">AI review failed</div>${escapeHtml(err.message)}`;
    statusEl.textContent = "";
  } finally {
    btn.disabled = false;
    btn.textContent = "Run AI Review";
  }
}

function renderDocumentsPanel(source, considered, excluded) {
  const panel = el("ai-documents-panel");
  panel.classList.remove("callout--risk");
  panel.hidden = false;
  const sourceLabel = source === "uploaded" ? "uploaded files" : "local KSRT folder (local development only)";
  const consideredHtml = considered.length
    ? considered.map((label) => escapeHtml(label)).join(", ")
    : "none";
  const excludedHtml = excluded.length
    ? `<ul style="margin:4px 0 0 18px;padding:0">${excluded
        .map((d) => `<li>${escapeHtml(d.label)} — <span class="documents-panel__excluded-reason">${escapeHtml(d.reason)}</span></li>`)
        .join("")}</ul>`
    : "none";
  panel.innerHTML = `
    <div class="callout__title">Documents used for this AI review</div>
    <div class="documents-panel">
      <div class="documents-panel__group"><span class="documents-panel__label">Source:</span>${escapeHtml(sourceLabel)}</div>
      <div class="documents-panel__group"><span class="documents-panel__label">Considered:</span>${consideredHtml}</div>
      <div class="documents-panel__group"><span class="documents-panel__label">Excluded:</span>${excludedHtml}</div>
    </div>`;
}

async function handleSaveMeta() {
  const id = state.currentSubmissionId;
  const payload = {
    project_name: el("detail-project-name").value,
    riba_stage: el("detail-riba-stage").value,
    submission_date: el("detail-submission-date").value,
    notes: el("detail-notes").value,
  };
  try {
    const updated = await api(`/api/submissions/${id}`, { method: "PUT", body: JSON.stringify(payload) });
    el("detail-eyebrow").textContent = updated.riba_stage;
    el("detail-title").textContent = updated.project_name;
    el("detail-subtitle").textContent = `Submitted ${formatDate(updated.submission_date)}`;
    el("meta-save-status").textContent = "Saved.";
    setTimeout(() => (el("meta-save-status").textContent = ""), 2000);
  } catch (err) {
    el("meta-save-status").textContent = err.message;
  }
}

async function handleDeleteFromDetail() {
  const id = state.currentSubmissionId;
  const projectName = el("detail-project-name").value;
  if (!confirm(`Delete submission "${projectName}" and its checklist? This cannot be undone.`)) return;
  await api(`/api/submissions/${id}`, { method: "DELETE" });
  showDashboard();
}

/* ---------------------------------------------------------------------- */
/* Init                                                                     */
/* ---------------------------------------------------------------------- */
async function init() {
  state.ribaStages = await api("/api/riba-stages");

  el("btn-new-submission").addEventListener("click", openNewModal);
  el("btn-close-modal").addEventListener("click", closeNewModal);
  el("btn-cancel-modal").addEventListener("click", closeNewModal);
  el("form-new-submission").addEventListener("submit", handleCreateSubmission);
  el("modal-new").addEventListener("click", (evt) => {
    if (evt.target.id === "modal-new") closeNewModal();
  });

  el("btn-back").addEventListener("click", showDashboard);
  el("btn-save-meta").addEventListener("click", handleSaveMeta);
  el("btn-delete-submission").addEventListener("click", handleDeleteFromDetail);
  el("btn-run-ai-review").addEventListener("click", handleRunAiReview);

  showDashboard();
}

init();
