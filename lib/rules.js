// Sayso's built-in engine: turns a dictated call recap into a CRM record with plain rules, so the app works with
// no API key. Claude (lib/claude.js) is used instead when a key is set. Every function returns the same shapes
// as the Claude versions in lib/extract.js.

const DEAL_STAGES = ["lead", "qualified", "demo", "proposal", "negotiation", "won", "lost"];
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_ALIASES = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const SMALL = { zero: 0, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const DIGIT_WORDS = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
const SCALE = { thousand: 1e3, k: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, crore: 1e7, crores: 1e7, cr: 1e7, million: 1e6, mn: 1e6, m: 1e6 };

// ---------- text helpers ----------
const FILLER = /\b(um+|uh+|erm|like,|you know,?|basically,?|so yeah,?)\s*/gi;
const clean = (s) => s.replace(FILLER, "").replace(/\s+/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
// "Tuesday, no wait, Thursday" → "Thursday": keep what the speaker corrected to.
const fixCorrections = (s) => s.replace(/\b([\w'-]+),?\s+(?:no wait|no,? sorry|sorry|I mean|actually no|no no|scratch that),?\s+([\w'-]+)/gi, "$2");
const sentences = (text) => clean(text).split(/(?<=[.!?])\s+(?=[A-Za-z"'])/).map((s) => s.trim()).filter(Boolean);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const stripEnd = (s) => s.replace(/[\s,;:.!?]+$/, "");
const LOWER_WORDS = new Set(["of", "and", "the", "for", "at", "in", "on", "to"]);
const titleCase = (s) => s.split(/\s+/).map((w, i) => (i && LOWER_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : /^[A-Z]{2,}$/.test(w) ? w : cap(w.toLowerCase()))).join(" ");
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseDay = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// "two hours", "four lakh", "1.5", "one and a half", "twenty five" → number (or null)
export function wordsToNumber(raw) {
  const s = raw.toLowerCase().replace(/,/g, "").trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const words = s.replace(/-/g, " ").split(/\s+/).filter((w) => w !== "and");
  if (!words.length) return null;
  let total = 0, current = 0, seen = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if ((w === "a" || w === "an") && words[i + 1] === "half") continue; // "one and a half"
    if (w in SMALL) { current += SMALL[w]; seen = true; }
    else if (w in TENS) { current += TENS[w]; seen = true; }
    else if (w === "hundred") { current = (current || 1) * 100; seen = true; }
    else if (w === "half") { current += 0.5; seen = true; }
    else if (w === "point" && words[i + 1] in SMALL) { current += SMALL[words[++i]] / 10; }
    else if (/^\d+(\.\d+)?$/.test(w)) { current += Number(w); seen = true; }
    else return null;
  }
  return seen ? total + current : null;
}

// ---------- field extractors ----------
const DOMAIN_TLDS = "co dot in|co dot uk|com|in|io|co|org|net|ai|app|dev|us|uk"; // longest first

export function findEmail(text) {
  const literal = text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/);
  if (literal) return literal[0].toLowerCase();
  // Spoken: "priya dot n at acme logistics dot in"
  const spoken = new RegExp(`\\b([a-z0-9]+(?:\\s+(?:dot|underscore|dash)\\s+[a-z0-9]+)*)\\s+at\\s+([a-z0-9]+(?:[\\s-][a-z0-9]+){0,3}?)\\s+dot\\s+(${DOMAIN_TLDS})\\b`, "i").exec(text);
  if (!spoken) return "";
  const local = spoken[1].toLowerCase().replace(/\s+dot\s+/g, ".").replace(/\s+underscore\s+/g, "_").replace(/\s+dash\s+/g, "-").replace(/\s+/g, "");
  const domain = spoken[2].toLowerCase().replace(/[\s-]+/g, "");
  const tld = spoken[3].toLowerCase().replace(/\s+dot\s+/g, ".");
  return `${local}@${domain}.${tld}`;
}

export function findPhone(text) {
  // Spoken digits ("nine eight two zero…") become numbers first.
  const spokenDigits = text.replace(/\b((?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)[\s,-]+){7,}(?:zero|oh|one|two|three|four|five|six|seven|eight|nine))\b/gi,
    (m) => m.toLowerCase().split(/[\s,-]+/).map((w) => DIGIT_WORDS[w]).join(""));
  const m = spokenDigits.match(/(\+?\d[\d\s-]{8,}\d)/);
  if (!m) return "";
  const digits = m[1].replace(/[^\d+]/g, "");
  if (digits.replace("+", "").length < 10) return "";
  if (/^\d{10}$/.test(digits)) return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  return m[1].replace(/\s+/g, " ").trim();
}

const NAME_TRIGGERS = /\b(?:call|chat|meeting|spoke|speaking|talked|talking|met|catch(?:-|\s)?up|demo|conversation)\s+(?:with|to)\s+(?:a\s+|the\s+)?/i;
const NOT_NAME = new Set(["her", "him", "them", "their", "the", "a", "an", "our", "my", "his", "she", "he", "they", "team", "client", "customer", "prospect", "someone", "somebody", "lead", "founder", "owner", "head", "ceo", "cto", "manager", "director", "vp"]);

export function findName(text) {
  const t = NAME_TRIGGERS.exec(text);
  if (t) {
    const after = text.slice(t.index + t[0].length).split(/[,.;!?]| from | at | who | about | regarding | she | he | they /i)[0];
    const words = after.trim().split(/\s+/).filter(Boolean);
    const name = [];
    for (const w of words) {
      if (NOT_NAME.has(w.toLowerCase()) || !/^[A-Za-z][A-Za-z'.-]*$/.test(w)) break;
      name.push(w);
      if (name.length === 3) break;
    }
    if (name.length) return titleCase(name.join(" "));
  }
  const intro = text.match(/\b(?:[Nn]ame is|[Tt]his is|[Mm]et(?: with)?)\s+([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+){0,2})/);
  if (intro) return intro[1];
  // "<Name> from <Company>" with capitalised words
  const from = text.match(/\b([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+)?)\s+from\s+[A-Z]/);
  return from ? from[1] : "";
}

const ROLE_WORDS = "head of [a-z&]+(?: (?!at\\b|in\\b|for\\b|from\\b|with\\b|of\\b)[a-z&]+)?|vp of [a-z]+|vp [a-z]+|vice president of [a-z]+|director of [a-z]+(?: [a-z]+)?|chief [a-z]+ officer|ceo|cto|cfo|coo|cmo|founder|co-?founder|owner|partner|[a-z]+ manager|manager|[a-z]+ lead|team lead|[a-z]+ engineer|[a-z]+ director|director|consultant|principal|president|practice manager|procurement [a-z]+";
export function findRole(text) {
  const m = new RegExp(`\\b(?:she's|he's|they're|she is|he is|they are|who is|who's|is the|is their|is our|as)\\s+(?:the\\s+|their\\s+|a\\s+|an\\s+)?(${ROLE_WORDS})\\b`, "i").exec(text)
    || new RegExp(`,\\s*(?:the\\s+)?(${ROLE_WORDS})\\s+(?:at|of)\\b`, "i").exec(text);
  if (!m) return "";
  return titleCase(m[1].replace(/\bops\b/i, "Ops").replace(/\bcofounder\b/i, "co-founder")).replace(/\b(Ceo|Cto|Cfo|Coo|Cmo|Vp)\b/g, (w) => w.toUpperCase()).replace(/\bOps\b/i, "Ops");
}

export function findCompany(text, personName = "") {
  const candidates = [
    /\b(?:company is|company's|works at|working at|work at|from|at|with|of)\s+([A-Z][\w&'.-]*(?:\s+(?:[A-Z][\w&'.-]*|&|and))*(?:\s+[A-Z][\w&'.-]*)?)/g,
  ];
  for (const re of candidates) {
    for (const m of text.matchAll(re)) {
      let name = m[1].split(/\.\s/)[0].replace(/[.,]+$/, "").replace(/\s+(?:and|&)$/i, "").trim();
      if (personName && (personName.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(personName.toLowerCase()))) continue;
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 6).toLowerCase();
      if (/^\s+dot\b/.test(after)) continue; // part of a spoken email
      const first = name.split(/\s+/)[0];
      if (["I", "I'll", "I'm", "The", "This", "That", "Her", "His", "Their", "She", "He", "They", "We", "Our", "My"].includes(first)) continue;
      if (DAYS.includes(first.toLowerCase()) || MONTHS.includes(first.toLowerCase())) continue;
      // "VP of Sales at Northwind": a department isn't the company.
      if (/^(sales|ops|operations|marketing|engineering|product|finance|growth|hr|people|procurement|it|support|design|partnerships)$/i.test(name)) continue;
      return name;
    }
  }
  return "";
}

// Money: "four lakh rupees a year", "₹2,40,000", "$12k", "12,000 dollars per month"
export function findValue(text, defaultCurrency = "₹") {
  const sents = sentences(text);
  const scored = [];
  for (const s of sents) {
    const lower = s.toLowerCase();
    const weight = /\b(budget|deal|worth|value|pricing|price|contract|spend|pay|ticket|cost|annual|arr|mrr|quote)\b/.test(lower) ? 2 : 1;
    for (const amount of amountsIn(s, defaultCurrency)) scored.push({ ...amount, weight });
  }
  if (!scored.length) return "";
  scored.sort((a, b) => b.weight - a.weight);
  const best = scored[0];
  return formatMoney(best.value, best.currency) + best.period;
}

const formatMoney = (n, cur) => `${cur}${n.toLocaleString(cur === "₹" ? "en-IN" : "en-US")}`;

// Which currency a sentence names, if any: lakh and crore are Indian, so they mean rupees.
function currencyIn(text) {
  if (/₹|\brs\.?\b|\binr\b|\brupees?\b|\blakhs?\b|\blacs?\b|\bcrores?\b/i.test(text)) return "₹";
  if (/\$|\bdollars?\b|\busd\b|\bbucks\b/i.test(text)) return "$";
  if (/€|\beuros?\b|\beur\b/i.test(text)) return "€";
  if (/£|\bpounds?\b|\bgbp\b|\bquid\b/i.test(text)) return "£";
  return "";
}

function amountsIn(sentence, defaultCurrency = "₹") {
  const out = [];
  const lower = sentence.toLowerCase();
  const period = /\b(a|per|each|every)\s+(year|annum)\b|\b(annually|yearly|per annum)\b|\/\s*(yr|year)\b/.test(lower) ? "/yr"
    : /\b(a|per|each|every)\s+month\b|\bmonthly\b|\/\s*(mo|month)\b/.test(lower) ? "/mo" : "";
  const re = /(?:(₹|rs\.?|inr|\$|€|£)\s*)?((?:\d[\d,]*(?:\.\d+)?)|(?:(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|half|and|point)[\s-]*)+)\s*(lakhs?|lacs?|crores?|cr|k|thousand|million|mn)?\b\s*(rupees|rs|inr|dollars|usd|bucks|euros?|eur|pounds|gbp)?/gi;
  for (const m of sentence.matchAll(re)) {
    const [, symbol, num, scale, unit] = m;
    if (!symbol && !scale && !unit) continue; // a bare number isn't money
    if (/^\d{9,}$/.test(num.replace(/[,\s]/g, ""))) continue; // phone numbers
    const n = wordsToNumber(num.trim());
    if (n == null || n === 0) continue;
    const value = Math.round(n * (scale ? SCALE[scale.toLowerCase()] : 1));
    if (value < 100) continue;
    // The amount's own words decide first ("$24k", "four lakh"), then the sentence, then the company default.
    const currency = currencyIn(`${symbol ?? ""} ${scale ?? ""} ${unit ?? ""}`) || currencyIn(sentence) || defaultCurrency;
    out.push({ value, currency, period });
  }
  return out;
}

// Dates are resolved against `today`; the last date said in a follow-up sentence wins, so
// "Tuesday, no wait, Thursday" gives Thursday.
const DATE_RE = new RegExp([
  "\\b(day after tomorrow|tomorrow|today|tonight)\\b",
  "\\b(next week|end of (?:the )?week|end of (?:the )?month|next month)\\b",
  `\\b(?:(next|this|coming)\\s+)?(${DAYS.join("|")}|${Object.keys(DAY_ALIASES).join("|")})\\b`,
  "\\bin\\s+(a|an|one|two|three|four|five|six|seven|\\d+)\\s+(days?|weeks?)\\b",
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS.join("|")}|${MONTHS.map((m) => m.slice(0, 3)).join("|")})\\b`,
  `\\b(${MONTHS.join("|")}|${MONTHS.map((m) => m.slice(0, 3)).join("|")})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`,
].join("|"), "gi");

export function resolveDate(phrase, today) {
  DATE_RE.lastIndex = 0;
  const m = DATE_RE.exec(phrase);
  if (!m) return "";
  const p = m[0].toLowerCase();
  const t = parseDay(today);
  if (/day after tomorrow/.test(p)) return iso(addDays(t, 2));
  if (/tomorrow/.test(p)) return iso(addDays(t, 1));
  if (/today|tonight/.test(p)) return iso(t);
  if (/next week/.test(p)) return iso(addDays(t, ((8 - t.getDay()) % 7) || 7)); // next Monday
  if (/end of (the )?week/.test(p)) return iso(addDays(t, ((5 - t.getDay() + 7) % 7) || 7));
  if (/end of (the )?month/.test(p)) return iso(new Date(t.getFullYear(), t.getMonth() + 1, 0));
  if (/next month/.test(p)) return iso(new Date(t.getFullYear(), t.getMonth() + 1, 1));
  const inN = /in\s+(\S+)\s+(day|week)/.exec(p);
  if (inN) return iso(addDays(t, (wordsToNumber(inN[1]) ?? 1) * (inN[2] === "week" ? 7 : 1)));
  const dayWord = Object.keys(DAY_ALIASES).concat(DAYS).find((d) => new RegExp(`\\b${d}\\b`).test(p));
  if (dayWord) {
    const dow = DAYS.includes(dayWord) ? DAYS.indexOf(dayWord) : DAY_ALIASES[dayWord];
    return iso(addDays(t, ((dow - t.getDay() + 7) % 7) || 7));
  }
  const monthIdx = MONTHS.findIndex((mo) => p.includes(mo.slice(0, 3)));
  const dayNum = Number((p.match(/\d{1,2}/) ?? [])[0]);
  if (monthIdx >= 0 && dayNum) {
    let d = new Date(t.getFullYear(), monthIdx, dayNum);
    if (d < t) d = new Date(t.getFullYear() + 1, monthIdx, dayNum);
    return iso(d);
  }
  return "";
}

const FOLLOW_UP_CONTEXT = /\b(follow(?:ing)?[\s-]?up|call (?:her|him|them|back)|check (?:in|back)|reconnect|catch up|touch base|get back|ping|meet|meeting|demo|circle back|speak again|talk again|send|by|on)\b/i;
export function findFollowUpDate(text, today) {
  let found = "";
  for (const s of sentences(text)) {
    if (!FOLLOW_UP_CONTEXT.test(s)) continue;
    const all = [...s.matchAll(DATE_RE)];
    if (all.length) found = resolveDate(all.at(-1)[0], today) || found;
  }
  return found;
}

export function findStage(text) {
  const t = text.toLowerCase();
  if (/\b(not interested|went with (another|a competitor|someone else)|lost (the|this) deal|passed on|no budget (left|this year)|budget (is )?frozen|said no|not moving forward|chose (another|a competitor))\b/.test(t)) return "lost";
  if (/\b(signed|closed (the deal|it)|we won|won the deal|they('re| are) in|purchase order|po (is )?(raised|sent)|agreed to (buy|go ahead|sign)|onboarding)\b/.test(t)) return "won";
  if (/\b(negotiat\w*|discount|legal review|contract review|redlines?|security questionnaire|procurement|terms|pricing is agreed|agreed in principle)\b/.test(t)) return "negotiation";
  if (/\b(proposal|quote|quotation|send (?:over )?(?:the )?pricing|pricing for|revised pricing|estimate)\b/.test(t)) return "proposal";
  if (/\b(demo|walkthrough|walk-through|trial|pilot)\b/.test(t)) return "demo";
  if (/\b(interested|keen|budget|needs?|looking for|pain|problem|losing|struggl\w*|wants?|evaluating)\b/.test(t)) return "qualified";
  return "lead";
}

const PAIN = /\b(losing|lose|lost time|gets? lost|lost in|miss(es|ing)?|struggl\w*|problem|pain|manual(ly)?|spreadsheets?|slow|keep(s)? getting|keep(s)? missing|can't|cannot|hard to|frustrat\w*|wast\w*|issue|double[- ]booked|errors?|mess|chaos|no visibility|no view|scattered|delays?)\b/i;
export function findPainPoints(text) {
  const out = [];
  for (const s of sentences(text)) {
    if (!PAIN.test(s)) continue;
    for (let part of s.split(/\s*(?:,\s*and|;|\band\b(?=\s+(?:their|the|they|it|we|our|she|he)\b))\s*/i)) {
      if (!PAIN.test(part)) continue;
      part = stripEnd(part).replace(/^(?:and|but|so|also)\s+/i, "").replace(/^(?:they're|they are|we're|she's|he's|it's)\s+/i, "").replace(/^(?:their|the)\s+/i, "");
      if (part.split(/\s+/).length < 2) continue;
      out.push(cap(part.length > 90 ? part.slice(0, 87).trim() + "…" : part));
    }
  }
  return [...new Set(out)].slice(0, 4);
}

const ACTION = /\b(I'll|I will|I'm going to|I need to|I have to|we'll|we will|let me|next step is|going to send|will send)\b\s*/i;
export function findActions(text) {
  const out = [];
  for (const s of sentences(text)) {
    const m = ACTION.exec(s);
    if (!m) continue;
    for (let part of s.slice(m.index + m[0].length).split(/\s*(?:,\s*)?\band\b\s*(?=(?:then\s+)?(?:send|share|schedule|book|follow|call|email|set|get|check|loop|ping|draft|prepare|update)\b)/i)) {
      part = stripEnd(part).replace(/,?\s*(?:no wait|actually|I mean|sorry),?\s*.*$/i, "");
      if (part.split(/\s+/).length < 2) continue;
      out.push(cap(part));
    }
  }
  return [...new Set(out)].slice(0, 4);
}

export function findSentiment(text) {
  const t = text.toLowerCase();
  const pos = (t.match(/\b(excited|loved|love|keen|interested|great|happy|impressed|wants?|eager|liked|positive|signed|won)\b/g) ?? []).length;
  const neg = (t.match(/\b(not interested|no budget|frustrated|annoyed|unhappy|lost|concerned|worried|hesitant|skeptical|sceptical|pushback|not sure)\b/g) ?? []).length;
  return pos > neg ? "positive" : neg > pos ? "negative" : "neutral";
}

function summarise(text, rec) {
  const sents = sentences(text);
  const intro = [rec.contact_name, rec.role && (rec.company ? `${rec.role} at ${rec.company}` : rec.role), !rec.role && rec.company].filter(Boolean).join(", ");
  const useful = sents.filter((s) => /\b(want|wants|need|needs|interested|looking|losing|struggl|budget|keen|asked|plan|evaluat|using|runs?|currently|problem|signed|liked)\w*/i.test(s)
    && !/\b(email|phone|number) is\b/i.test(s));
  const body = useful.slice(0, 2).map((s) => s.replace(/^(?:just got off (?:a |the )?(?:call|phone) with [^,.]+[,.]\s*)/i, "")).filter((s) => s.split(" ").length > 3);
  const summary = [intro && `${intro}.`, ...body].filter(Boolean).join(" ");
  return summary || stripEnd(sents[0] ?? "") + ".";
}

// ---------- the four tasks ----------
export function extract(transcript, today = iso(new Date()), { currency = "₹" } = {}) {
  const text = fixCorrections(clean(transcript));
  const contactName = findName(text);
  const record = {
    contact_name: contactName,
    company: findCompany(text, contactName),
    email: findEmail(text),
    phone: findPhone(text),
    role: findRole(text),
    deal_stage: findStage(text),
    deal_value: findValue(text, currency),
    next_step: "",
    follow_up_date: findFollowUpDate(text, today),
    summary: "",
    pain_points: findPainPoints(text),
    action_items: findActions(text),
    sentiment: findSentiment(text),
  };
  if (record.follow_up_date && !record.action_items.some((a) => /follow/i.test(a))) {
    record.action_items = [...record.action_items, `Follow up on ${new Date(record.follow_up_date + "T00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}`].slice(0, 4);
  }
  record.next_step = record.action_items[0] ?? "";
  record.summary = summarise(text, record);
  return record;
}

const FIELD_ALIASES = [
  ["deal_value", /\b(?:deal value|value|budget|deal size|amount|price|contract value|worth)\b/i],
  ["deal_stage", /\b(?:stage|status|deal stage)\b/i],
  ["follow_up_date", /\b(?:follow[\s-]?up(?: date)?|callback|call back date)\b/i],
  ["next_step", /\b(?:next step|next action|to-?do)\b/i],
  ["email", /\b(?:email|e-mail|mail id)\b/i],
  ["phone", /\b(?:phone|number|mobile|cell)\b/i],
  ["company", /\b(?:company|organisation|organization|business)\b/i],
  ["role", /\b(?:role|title|designation|position)\b/i],
  ["contact_name", /\b(?:name|contact)\b/i],
  ["summary", /\b(?:summary|notes?)\b/i],
];

// Spoken corrections: "the value is five lakh", "change the stage to proposal", "move the follow-up to Monday",
// "her email is actually priya dot n at acme dot in". Returns the full record with only those fields changed.
export function revise(record, instruction, today = iso(new Date())) {
  const said = clean(instruction).replace(/[.!]+$/, "");
  const next = { ...record };
  let changed = false;
  for (const clause of said.split(/\s*(?:,\s*and|;|\band also\b|\band\b(?=\s+(?:the|her|his|their|change|set|move|make)\b))\s*/i)) {
    const field = FIELD_ALIASES.find(([, re]) => re.test(clause))?.[0];
    const value = (clause.match(/\b(?:to|is|should be|=|as|becomes|now)\s+(?:actually\s+)?(.+)$/i) ?? [])[1];
    if (field === "deal_stage" || (!field && DEAL_STAGES.some((st) => new RegExp(`\\b${st}\\b`, "i").test(clause)))) {
      const stage = DEAL_STAGES.find((st) => new RegExp(`\\b${st}\\b`, "i").test(clause)) ?? (/\bclosed\b|\bsigned\b/i.test(clause) ? "won" : "");
      if (stage) { next.deal_stage = stage; changed = true; }
      continue;
    }
    if (field === "deal_value" || (!field && amountsIn(clause).length)) {
      const current = (record.deal_value ?? "").match(/^[₹$€£]/)?.[0] ?? "₹";
      let v = findValue(clause, current) || findValue(`${clause} budget`, current);
      // "five lakh" keeps the old "/yr" or "/mo" unless a new period was said.
      const oldPeriod = (record.deal_value ?? "").match(/\/(yr|mo)$/)?.[0];
      if (v && oldPeriod && !/\/(yr|mo)$/.test(v)) v += oldPeriod;
      if (v) { next.deal_value = v; changed = true; }
      continue;
    }
    if (field === "follow_up_date" || (!field && /\b(move|push|reschedule)\b/i.test(clause))) {
      DATE_RE.lastIndex = 0;
      const dates = [...clause.matchAll(DATE_RE)];
      const d = dates.length ? resolveDate(dates.at(-1)[0], today) : "";
      if (d) { next.follow_up_date = d; changed = true; }
      continue;
    }
    if (field === "email") { const e = findEmail(value ?? clause); if (e) { next.email = e; changed = true; } continue; }
    if (field === "phone") { const p = findPhone(value ?? clause); if (p) { next.phone = p; changed = true; } continue; }
    if (field && value) {
      const v = stripEnd(value);
      next[field] = field === "next_step" || field === "summary" ? cap(v) : field === "role" ? titleCase(v) : field === "contact_name" || field === "company" ? titleCase(v) : v;
      changed = true;
    }
  }
  if (!changed) throw Object.assign(new Error("I couldn't tell which field to change. Try “stage is proposal”, “the value is five lakh” or “follow up on Monday”."), { status: 422 });
  return next;
}

const fmtDate = (d) => new Date(d + "T00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

export function followup(record, transcript, sender, { product = "" } = {}) {
  const first = (record.contact_name || "").split(/\s+/)[0] || "there";
  const pains = record.pain_points ?? [];
  const step = record.next_step ? lowerFirst(stripEnd(record.next_step)).replace(/^(?:i'll|i will)\s+/i, "") : "";
  const subject = record.deal_stage === "demo" ? `Demo for ${record.company || "your team"}${record.follow_up_date ? `: ${new Date(record.follow_up_date + "T00:00").toLocaleDateString("en-GB", { weekday: "long" })}` : ""}`
    : record.deal_stage === "proposal" ? `Proposal for ${record.company || "you"}`
    : record.deal_stage === "negotiation" ? `Next steps for ${record.company || "us"}`
    : record.deal_stage === "won" ? `Welcome aboard, ${first}`
    : `Following up on our call`;
  const paragraphs = [`Hi ${first},`];
  if (record.deal_stage === "lost") {
    paragraphs.push(`Thanks for being straight with me today. I understand the timing isn't right.${record.follow_up_date ? ` I'll check back in around ${fmtDate(record.follow_up_date)}, in case things change.` : ""}`);
  } else {
    const thanks = `Thanks for your time today${record.company ? `, it was good to hear how things work at ${record.company}` : ""}.`;
    const heard = pains.length ? ` You mentioned ${lowerFirst(pains[0])}${pains[1] ? `, and that ${lowerFirst(pains[1])}` : ""}. That's exactly what ${product || "we"} help${product ? "s" : ""} with.` : "";
    paragraphs.push(thanks + heard);
    const plan = [step && !/^follow up\b/i.test(step) && `As discussed, I'll ${step}.`, record.follow_up_date ? `Does ${fmtDate(record.follow_up_date)} work to pick this up?` : "Let me know a good time to pick this up."].filter(Boolean);
    paragraphs.push(plan.join(" "));
  }
  paragraphs.push(`Best,\n${sender || ""}`.trim());
  return { subject, body: paragraphs.join("\n\n") };
}

// ---------- ask your pipeline ----------
const parseAmount = (v) => {
  const n = Number(String(v ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? { n, cur: String(v).includes("$") ? "$" : "₹" } : null;
};
const money = (n, cur) => (cur === "$" ? `$${n.toLocaleString("en-US")}` : `₹${n.toLocaleString("en-IN")}`);

// Calls are referred to as C1…Cn in the order given (newest first), matching the Claude version.
export function ask(calls, question, today = iso(new Date())) {
  const q = question.toLowerCase();
  const list = calls.slice(0, 200).map((c, i) => ({ ...c, ref: `C${i + 1}` }));
  if (!list.length) return { answer: "There are no calls logged yet, so there's nothing to answer from.", sources: [] };
  const t = parseDay(today);
  const who = (c) => `${c.contact_name || "Unknown"}${c.company ? ` (${c.company})` : ""}`;
  const when = (d) => { const diff = Math.round((parseDay(d) - t) / 86400000); return diff === 0 ? "today" : diff === 1 ? "tomorrow" : diff < 0 ? `${-diff} day${diff === -1 ? "" : "s"} overdue` : new Date(d + "T00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); };
  const answer = (lines, used) => ({ answer: lines.join("\n"), sources: [...new Set(used.map((c) => c.ref))] });
  // Latest call per contact, so old calls don't double-count.
  const latest = [];
  for (const c of list) if (!latest.some((l) => sameContact(l, c))) latest.push(c);

  if (/\b(follow[\s-]?up|due|this week|today|tomorrow|overdue|chase|remind|call back|who should i (call|contact|follow))\b/.test(q)) {
    const horizon = /\btoday\b/.test(q) ? 0 : /\btomorrow\b/.test(q) ? 1 : 7;
    const due = latest.filter((c) => c.follow_up_date && !c.follow_up_done && (parseDay(c.follow_up_date) - t) / 86400000 <= horizon && !["won", "lost"].includes(c.deal_stage) || (c.follow_up_date && !c.follow_up_done && parseDay(c.follow_up_date) < t))
      .sort((a, b) => a.follow_up_date.localeCompare(b.follow_up_date));
    if (!due.length) return answer(["Nothing is due in that window. Every follow-up is either done or later."], []);
    return answer([`${due.length} follow-up${due.length === 1 ? "" : "s"} need${due.length === 1 ? "s" : ""} you:`, ...due.slice(0, 6).map((c) => `- ${who(c)}: ${c.next_step && !/^follow up\b/i.test(c.next_step) ? `${lowerFirst(c.next_step)}, ` : "follow up "}${when(c.follow_up_date)} [${c.ref}]`)], due);
  }
  if (/\b(stuck|stall|stalled|blocked|slipping|at risk|cold|going nowhere)\b/.test(q)) {
    const open = latest.filter((c) => !["won", "lost"].includes(c.deal_stage));
    const stuck = open.filter((c) => (c.follow_up_date && !c.follow_up_done && parseDay(c.follow_up_date) < t) || (t - new Date(c.created_at)) / 86400000 > 10);
    if (!stuck.length) return answer(["No open deal looks stuck: nothing is overdue and every deal has had a call in the last 10 days."], []);
    return answer([`${stuck.length} deal${stuck.length === 1 ? " looks" : "s look"} stuck:`, ...stuck.slice(0, 6).map((c) => `- ${who(c)}, ${c.deal_stage}: ${c.follow_up_date && parseDay(c.follow_up_date) < t ? `follow-up ${when(c.follow_up_date)}` : "no call in over 10 days"}${c.next_step ? ` (next: ${lowerFirst(c.next_step)})` : ""} [${c.ref}]`)], stuck);
  }
  if (/\b(problems?|pains?|complain\w*|mention most|objections?|issues?|challenges?|struggl\w*)\b/.test(q)) {
    const STOP = new Set(["the", "a", "an", "and", "of", "on", "in", "to", "their", "they", "for", "with", "about", "hours", "hour", "day", "days", "keep", "getting", "losing", "get", "no", "is", "are"]);
    const counts = new Map();
    for (const c of list) for (const p of c.pain_points ?? []) for (const w of new Set(p.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? [])) {
      if (STOP.has(w)) continue;
      const e = counts.get(w) ?? { n: 0, calls: [] };
      e.n++; e.calls.push(c); counts.set(w, e);
    }
    const top = [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 3);
    if (!top.length) return answer(["No pain points are recorded on your calls yet."], []);
    return answer(["What comes up most:", ...top.map(([w, e]) => `- ${cap(w)}: ${e.n} call${e.n === 1 ? "" : "s"}, e.g. “${(e.calls[0].pain_points.find((p) => p.toLowerCase().includes(w)))}” ${[...new Set(e.calls.map((c) => `[${c.ref}]`))].slice(0, 3).join(" ")}`)], top.flatMap(([, e]) => e.calls));
  }
  if (/\b(pipeline|summar\w*|overview|by stage|how much|total|value|worth|forecast)\b/.test(q)) {
    const lines = ["Your pipeline by stage (latest call per contact):"];
    const used = [];
    for (const stage of DEAL_STAGES) {
      const inStage = latest.filter((c) => c.deal_stage === stage);
      if (!inStage.length) continue;
      const sums = {};
      for (const c of inStage) { const a = parseAmount(c.deal_value); if (a) sums[a.cur] = (sums[a.cur] ?? 0) + a.n; }
      const total = Object.entries(sums).map(([cur, n]) => money(n, cur)).join(" + ");
      lines.push(`- ${cap(stage)}: ${inStage.length}${total ? `, ${total}` : ""} (${inStage.map((c) => `${c.contact_name || "Unknown"} [${c.ref}]`).join(", ")})`);
      used.push(...inStage);
    }
    return answer(lines, used);
  }
  const stageAsked = DEAL_STAGES.find((s) => new RegExp(`\\b${s}\\b`).test(q));
  if (stageAsked) {
    const inStage = latest.filter((c) => c.deal_stage === stageAsked);
    if (!inStage.length) return answer([`No deals are at ${stageAsked} right now.`], []);
    return answer([`${inStage.length} at ${stageAsked}:`, ...inStage.map((c) => `- ${who(c)}${c.deal_value ? `, ${c.deal_value}` : ""}${c.next_step ? `: ${lowerFirst(c.next_step)}` : ""} [${c.ref}]`)], inStage);
  }
  // Otherwise: who/what is X → match names, companies and notes.
  const terms = q.replace(/[^a-z0-9@. -]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !["what", "who", "whom", "tell", "about", "the", "with", "did", "does", "say", "said", "and", "for", "how", "was", "were", "call", "calls", "last", "any", "have", "has", "from", "our", "my"].includes(w));
  const scored = list.map((c) => {
    const hay = [c.contact_name, c.company, c.role, c.summary, c.next_step, ...(c.pain_points ?? [])].join(" ").toLowerCase();
    const strong = [c.contact_name, c.company].join(" ").toLowerCase();
    return { c, score: terms.reduce((s, w) => s + (strong.includes(w) ? 3 : hay.includes(w) ? 1 : 0), 0) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.c.created_at.localeCompare(a.c.created_at));
  if (!scored.length) return answer(["I couldn't find anything about that in your calls. Try asking about follow-ups, stuck deals, common problems, your pipeline, or a contact by name."], []);
  const hits = scored.slice(0, 3).map((x) => x.c);
  return answer([`Here's what your calls say:`, ...hits.map((c) => `- ${who(c)}, ${new Date(c.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${c.deal_stage}: ${c.summary || c.next_step || "no notes"} [${c.ref}]`)], hits);
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9@.]+/g, " ").trim();
function sameContact(a, b) {
  if (norm(a.email) && norm(b.email)) return norm(a.email) === norm(b.email);
  if (!norm(a.contact_name) || norm(a.contact_name) !== norm(b.contact_name)) return false;
  return !norm(a.company) || !norm(b.company) || norm(a.company) === norm(b.company);
}
