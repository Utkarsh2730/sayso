// CSV export (pure, no Node APIs), shared by the server and the static build.
const CSV_COLUMNS = [
  "created_at", "contact_name", "company", "email", "phone", "role", "deal_stage", "deal_value",
  "summary", "pain_points", "next_step", "follow_up_date", "sentiment", "action_items", "followup_subject", "followup_body",
];

const cell = (v) => {
  let s = Array.isArray(v) ? v.join("; ") : String(v ?? "");
  // Spreadsheet apps run cells starting with = + - @ as formulas; prefix them so exported text stays text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function toCsv(rows) {
  return [CSV_COLUMNS.join(","), ...rows.map((c) => CSV_COLUMNS.map((k) => cell(c[k])).join(","))].join("\n");
}
