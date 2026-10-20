// Optional sync to HubSpot (free CRM works). Needs a private-app token with contacts, notes and tasks scopes.
const API = "https://api.hubapi.com";

async function hs(token, method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HubSpot ${method} ${url} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function upsertContact(token, r) {
  const [firstname, ...rest] = r.contact_name.trim().split(/\s+/);
  const properties = Object.fromEntries(
    Object.entries({ firstname, lastname: rest.join(" "), email: r.email, company: r.company, phone: r.phone, jobtitle: r.role })
      .filter(([, v]) => v),
  );
  if (r.email) {
    const found = await hs(token, "POST", "/crm/v3/objects/contacts/search", {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: r.email }] }],
      limit: 1,
    });
    if (found.results?.[0]) {
      const id = found.results[0].id;
      await hs(token, "PATCH", `/crm/v3/objects/contacts/${id}`, { properties });
      return id;
    }
  }
  return (await hs(token, "POST", "/crm/v3/objects/contacts", { properties })).id;
}

const assoc = (contactId, typeId) => [
  { to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId }] },
];

export async function syncToHubSpot(token, r) {
  if (!r.contact_name && !r.email) throw new Error("Need at least a name or email to sync to HubSpot.");
  const contactId = await upsertContact(token, r);

  const lines = [
    r.summary,
    r.deal_stage && `Stage: ${r.deal_stage}`,
    r.deal_value && `Value: ${r.deal_value}`,
    r.pain_points.length && `Pain points: ${r.pain_points.join("; ")}`,
    r.action_items.length && `Action items: ${r.action_items.join("; ")}`,
    "Logged by voice with Voice CRM",
  ].filter(Boolean);
  await hs(token, "POST", "/crm/v3/objects/notes", {
    properties: { hs_timestamp: new Date().toISOString(), hs_note_body: lines.join("<br>") },
    associations: assoc(contactId, 202), // note -> contact
  });

  if (r.next_step) {
    const due = r.follow_up_date ? new Date(`${r.follow_up_date}T09:00:00`) : new Date(Date.now() + 86400000);
    await hs(token, "POST", "/crm/v3/objects/tasks", {
      properties: { hs_task_subject: r.next_step, hs_timestamp: due.toISOString(), hs_task_status: "NOT_STARTED" },
      associations: assoc(contactId, 204), // task -> contact
    });
  }
  return contactId;
}
