// Parses an incomplete JSON document as it streams in, returning the largest valid prefix as an object.
// Value strings still being written are included (so long fields like the summary appear as they're typed);
// half-written keys and unfinished numbers/literals are dropped until they complete.
const CLOSE = { "{": "}", "[": "]" };

export function parsePartialJson(text) {
  const stack = [];
  let inString = false, escaped = false, stringIsKey = false, afterColon = false;
  let safeEnd = 0, safeStack = [];
  const markSafe = (end) => { safeEnd = end; safeStack = [...stack]; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') {
        inString = false;
        if (!stringIsKey) markSafe(i + 1);
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      stringIsKey = stack.at(-1) === "{" && !afterColon;
      afterColon = false;
    } else if (c === "{" || c === "[") {
      stack.push(c);
      afterColon = false;
      markSafe(i + 1);
    } else if (c === "}" || c === "]") {
      stack.pop();
      markSafe(i + 1);
    } else if (c === ":") {
      afterColon = true;
    } else if (c === ",") {
      afterColon = false;
      markSafe(i); // everything before the comma is complete
    }
  }

  let candidate;
  if (inString && !stringIsKey) {
    // Close the open value string; drop a dangling backslash or partial \uXXXX escape.
    const body = text.replace(/\\(u[0-9a-fA-F]{0,3})?$/, "");
    candidate = body + '"' + stack.toReversed().map((b) => CLOSE[b]).join("");
  } else {
    candidate = text.slice(0, safeEnd) + safeStack.toReversed().map((b) => CLOSE[b]).join("");
  }
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}
