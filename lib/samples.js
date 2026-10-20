// Clearly-labelled sample calls that pre-fill a fresh demo workspace, so judges land on a populated app
// and "Ask your pipeline" has something to answer from. All people and companies are fictional.
const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString("en-CA");
const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();

const SAMPLES = [
  {
    hours: 5, contact_name: "Rahul Mehta", company: "Zeta Foods", email: "rahul@zetafoods.example", role: "Founder",
    deal_stage: "proposal", deal_value: "₹2,40,000/yr", next_step: "Send revised proposal with 3-outlet pricing", follow_up: 1, sentiment: "positive",
    summary: "Zeta runs 3 cloud kitchens and tracks supplier orders on WhatsApp. Rahul liked the demo and wants pricing for all three outlets.",
    pain_points: ["Supplier orders lost in WhatsApp threads", "No view of stock across outlets"], action_items: ["Revise proposal for 3 outlets"],
    source: "wispr", seconds: 34,
  },
  {
    hours: 28, contact_name: "Ananya Iyer", company: "Brightpath Tutors", role: "Operations lead",
    deal_stage: "qualified", deal_value: "", next_step: "Book a demo with her two centre managers", follow_up: -1, sentiment: "neutral",
    summary: "Brightpath schedules 40 tutors on spreadsheets. Ananya is interested but needs her centre managers to see it first.",
    pain_points: ["Tutor scheduling clashes", "Manual spreadsheets"], action_items: ["Get centre managers' availability"],
    source: "mic", seconds: 28,
  },
  {
    hours: 50, contact_name: "Vikram Shah", company: "Orbit Logistics", email: "vikram@orbitlogistics.example", role: "Head of Sales",
    deal_stage: "negotiation", deal_value: "₹6,00,000/yr", next_step: "Answer the security questionnaire their IT team sent", follow_up: 2, sentiment: "positive",
    summary: "Orbit wants it for 12 field reps. Pricing is agreed in principle; IT needs a security questionnaire before signing.",
    pain_points: ["Reps never update the CRM after site visits", "Manual spreadsheets"], action_items: ["Fill security questionnaire", "Share data-retention policy"],
    source: "wispr", seconds: 41,
  },
  {
    // An intro call with the person in the "Try a sample recap" text, so the demo shows contact history.
    hours: 96, contact_name: "Priya Nair", company: "Acme Logistics", email: "priya@acmelogistics.in", phone: "+91 98200 11223", role: "Head of Ops",
    deal_stage: "qualified", deal_value: "", next_step: "Book a demo for her team leads", follow_up: -1, sentiment: "positive",
    summary: "Intro call. Acme Logistics runs dispatch on spreadsheets; Priya wants to see a demo with her team leads.",
    pain_points: ["Manual dispatch spreadsheets"], action_items: ["Book the demo"],
    source: "wispr", seconds: 25,
  },
  {
    hours: 100, contact_name: "Arjun Desai", company: "Kitebird Travel", email: "arjun@kitebird.example", role: "COO",
    deal_stage: "won", deal_value: "₹1,80,000/yr", next_step: "Kick-off call to set up their HubSpot", follow_up: 4, sentiment: "positive",
    summary: "Kitebird signed for their 6-person sales desk. They want HubSpot sync set up during onboarding.",
    pain_points: ["Follow-ups missed after enquiry calls"], action_items: ["Schedule onboarding", "Connect HubSpot"],
    source: "wispr", seconds: 30,
  },
  {
    hours: 124, contact_name: "Farah Khan", company: "Nimbus Clinics", role: "Practice manager",
    deal_stage: "lost", deal_value: "₹90,000/yr", next_step: "Check back in January when their budget resets", follow_up: 75, sentiment: "negative",
    summary: "Nimbus liked the product but has no budget left this year. Farah asked to reconnect in January.",
    pain_points: ["Budget frozen until next financial year"], action_items: ["Set January reminder"],
    source: "mic", seconds: 26,
  },
];

export function sampleCalls() {
  return SAMPLES.map((s) => ({
    id: crypto.randomUUID(), created_at: ago(s.hours), is_sample: true,
    contact_name: s.contact_name, company: s.company, email: s.email ?? "", phone: s.phone ?? "", role: s.role,
    deal_stage: s.deal_stage, deal_value: s.deal_value, next_step: s.next_step, follow_up_date: day(s.follow_up),
    sentiment: s.sentiment, summary: s.summary, pain_points: s.pain_points, action_items: s.action_items,
    transcript: `(sample) ${s.summary}`, dictation_seconds: s.seconds, input_source: s.source, hubspot_status: "off",
  }));
}
