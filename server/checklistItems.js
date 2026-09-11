// Fixed checklist items applied to every submission. Order is display order.
const CHECKLIST_TEMPLATE = [
  { key: "calc_drawing", label: "Calculation → Drawing alignment" },
  { key: "drawing_revit", label: "Drawing → Revit Model alignment" },
  { key: "revit_coordination", label: "Revit Model coordination (clash-free)" },
  { key: "revit_health", label: "Revit Model health (per BIM Execution Plan)" },
  { key: "revit_boq", label: "Revit Model → BOQ alignment (quantities and descriptions)" },
  { key: "specs_deliverables", label: "Specs → all deliverables alignment" },
  { key: "voltage_drop", label: "Voltage drop check (must be ≤5%)" },
  { key: "qa_qc_signoff", label: "Overall QA/QC sign-off" },
];

const STATUS_VALUES = ["Checked", "Mismatch Found", "Not Applicable"];

module.exports = { CHECKLIST_TEMPLATE, STATUS_VALUES };
