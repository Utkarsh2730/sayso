// The company profile: who is using Sayso and what they sell. Pure functions, shared by the server and the
// live site's in-browser API.
export const CURRENCIES = ["₹", "$", "€", "£"];

export function cleanProfile(body = {}) {
  const str = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  return {
    mode: body.mode === "example" ? "example" : "own",
    company: str(body.company, 80),
    your_name: str(body.your_name, 80),
    product: str(body.product, 120),
    currency: CURRENCIES.includes(body.currency) ? body.currency : "₹",
    updated_at: new Date().toISOString(),
  };
}

// Email sign-off: the name typed in the email box (or the profile's), then the company.
export function signOff(profile, typedName = "") {
  const name = String(typedName || "").trim() || profile?.your_name || "";
  return [name, profile?.mode === "own" ? profile.company : ""].filter(Boolean).join("\n");
}
