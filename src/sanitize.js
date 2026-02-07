const FULL_REDACT_KEYWORDS = [
  "password",
  "passcode",
  "pass phrase",
  "passphrase",
  "pin",
  "cvv",
  "cvc",
  "security code",
  "routing number",
  "account number",
  "ssn",
  "social security",
  "iban",
  "swift",
  "api key",
  "secret",
  "token",
  "otp",
  "one-time",
  "2fa",
  "two-factor",
  "authorization code"
];

const KEY_SENSITIVE_HINTS = [
  "password",
  "passcode",
  "pin",
  "cvv",
  "cvc",
  "ssn",
  "social",
  "iban",
  "routing",
  "account",
  "secret",
  "token",
  "api"
];

const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD_LIKE_REGEX = /(?:\d[ -]*?){13,19}/g;

function hasKeyword(text, keywords) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword));
}

function luhnCheck(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const code = digits.charCodeAt(i);
    if (code < 48 || code > 57) {
      return false;
    }
    let n = code - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function redactCardNumbers(text) {
  let redacted = false;
  const result = text.replace(CARD_LIKE_REGEX, (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) {
      return match;
    }
    if (!luhnCheck(digits)) {
      return match;
    }
    redacted = true;
    return "[REDACTED]";
  });
  return { text: result, redacted };
}

function redactSensitiveText(value, keyHint) {
  if (hasKeyword(keyHint, KEY_SENSITIVE_HINTS)) {
    return { text: "[REDACTED]", redacted: true };
  }
  if (hasKeyword(value, FULL_REDACT_KEYWORDS)) {
    return { text: "[REDACTED]", redacted: true };
  }

  let redacted = false;
  let text = value.replace(SSN_REGEX, () => {
    redacted = true;
    return "[REDACTED]";
  });

  const cardResult = redactCardNumbers(text);
  text = cardResult.text;
  redacted = redacted || cardResult.redacted;

  return { text, redacted };
}

export function sanitizePayload(payload, log) {
  const redactedPaths = [];

  const walk = (value, path) => {
    if (Array.isArray(value)) {
      return value.map((item, index) => walk(item, `${path}[${index}]`));
    }
    if (value && typeof value === "object") {
      const out = {};
      for (const [key, entry] of Object.entries(value)) {
        const nextPath = path ? `${path}.${key}` : key;
        out[key] = walk(entry, nextPath);
      }
      return out;
    }
    if (typeof value === "string") {
      const keyHint = path.split(".").pop();
      const { text, redacted } = redactSensitiveText(value, keyHint);
      if (redacted) {
        redactedPaths.push(path);
      }
      return text;
    }
    return value;
  };

  const sanitized = walk(payload, "");
  if (redactedPaths.length > 0 && log) {
    log.warn({ redactedPaths }, "Sensitive data redacted from payload");
  }
  return sanitized;
}
