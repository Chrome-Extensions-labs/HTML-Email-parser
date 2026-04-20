(() => {
  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const PLAIN_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  const OBFUSCATED_RE = /[A-Z0-9._%+\-]+\s*(?:\[at\]|\(at\)|\sat\s|\[AT\]|＠|@)\s*[A-Z0-9.-]+\s*(?:\[dot\]|\(dot\)|\sdot\s|\.|\\.|・)\s*[A-Z]{2,}/gi;

  const PRIORITY_PREFIXES = [
    "ads@", "ad@", "advertising@", "advertise@", "marketing@", "partnerships@", "partners@",
    "business@", "publisher@", "sales@", "sale@", "ap@", "apps@", "app@", "web@", "webmaster@",
    "contact@", "contactus@", "website@", "games@", "game@", "ceo@", "info@", "hello@", "general@",
    "press@", "community@", "tech@", "accounts@", "no-reply@", "noreply@", "appcrm@", "orders@",
    "service@", "support@", "help@", "tips@", "letters@", "admin@", "app.contact@", "app.support@",
    "postmaster@", "notifications@", "information@"
  ];

  function decodeHtmlEntities(raw) {
    if (!raw || typeof raw !== "string") {
      return raw;
    }

    const element = document.createElement("textarea");
    element.innerHTML = raw;
    return element.value;
  }

  function normalizeText(raw) {
    if (!raw || typeof raw !== "string") {
      return raw;
    }

    return raw
      .replace(/[\u200B-\u200F\uFEFF\u2060-\u206F]/g, "")
      .replace(/＠/g, "@")
      .replace(/．|。|・|﹒/g, ".")
      .replace(/[‘’‚‛`´]/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  function deobfuscateText(raw) {
    if (!raw || typeof raw !== "string") {
      return raw;
    }

    return raw
      .replace(/\[at\]|\(at\)|\s+at\s+|\[AT\]/gi, "@")
      .replace(/\[dot\]|\(dot\)|\s+dot\s+/gi, ".")
      .replace(/\s*\+\s*/g, "")
      .replace(/[(),;]+$/g, "");
  }

  function isImageLike(raw) {
    if (!raw || typeof raw !== "string") {
      return false;
    }

    const value = raw.trim().toLowerCase();
    return /\.(jpe?g|png|gif|webp|svg|bmp|ico|tiff)(?:$|\W)/i.test(value) || /@\d+x\.|@2x\./.test(value);
  }

  function isGarbageEmail(rawEmail) {
    if (!rawEmail || typeof rawEmail !== "string") {
      return true;
    }

    const email = rawEmail.toLowerCase().trim();
    if (!email.includes("@")) {
      return true;
    }

    const [localPart, domainPart] = email.split("@");
    if (!localPart || !domainPart) {
      return true;
    }

    if (/^https?:/.test(localPart) || domainPart.includes("sentry") || domainPart.includes("hash")) {
      return true;
    }

    if (/^[0-9a-f]{12,}$/.test(localPart) || /^[0-9]{10,}$/.test(localPart)) {
      return true;
    }

    if (/\.(js|css|iife|min|bundle)$/i.test(domainPart) && /\d/.test(domainPart)) {
      return true;
    }

    return false;
  }

  function sanitizeCandidate(raw) {
    if (!raw || typeof raw !== "string") {
      return null;
    }

    const decoded = decodeHtmlEntities(raw);
    const normalized = normalizeText(decoded);
    const deobfuscated = deobfuscateText(normalized)
      .replace(/^mailto:?/i, "")
      .split("?")[0]
      .split("&")[0]
      .replace(/^[^A-Za-z0-9@]+/, "")
      .replace(/[^A-Za-z0-9@]+$/, "");

    const match = deobfuscated.match(EMAIL_RE);
    if (!match) {
      return null;
    }

    const email = match[0].toLowerCase().trim();
    if (isImageLike(email) || isGarbageEmail(email)) {
      return null;
    }

    return email;
  }

  function decodeCloudflareEmail(encoded) {
    if (!encoded || typeof encoded !== "string") {
      return null;
    }

    try {
      const key = parseInt(encoded.slice(0, 2), 16);
      let decoded = "";
      for (let index = 2; index < encoded.length; index += 2) {
        const charCode = parseInt(encoded.slice(index, index + 2), 16) ^ key;
        decoded += String.fromCharCode(charCode);
      }
      return decoded;
    } catch {
      return null;
    }
  }

  function extractFromText(rawText) {
    const foundEmails = new Set();
    if (!rawText || typeof rawText !== "string") {
      return foundEmails;
    }

    const normalizedText = normalizeText(decodeHtmlEntities(rawText));
    const combinedRegex = new RegExp(`(?:${PLAIN_RE.source})|(?:${OBFUSCATED_RE.source})`, "gi");

    for (const match of normalizedText.matchAll(combinedRegex)) {
      const candidate = sanitizeCandidate(match[0]);
      if (candidate) {
        foundEmails.add(candidate);
      }
    }

    const concatenationRegex = /(["'`][^"'`]{1,120}["'`]\s*\+\s*){1,8}(["'`][^"'`]{1,120}["'`])/g;
    let sequenceMatch = concatenationRegex.exec(normalizedText);
    while (sequenceMatch) {
      const parts = sequenceMatch[0].match(/(["'`])([^"'`]+)\1/g) || [];
      const joined = parts.map((entry) => entry.slice(1, -1)).join("");
      const candidate = sanitizeCandidate(joined);
      if (candidate) {
        foundEmails.add(candidate);
      }
      sequenceMatch = concatenationRegex.exec(normalizedText);
    }

    return foundEmails;
  }

  function sortByBusinessPriority(emails) {
    const unique = Array.from(new Set((emails || []).filter(Boolean).map((email) => email.toLowerCase().trim())));
    unique.sort((left, right) => {
      const leftPriority = PRIORITY_PREFIXES.findIndex((prefix) => left.startsWith(prefix));
      const rightPriority = PRIORITY_PREFIXES.findIndex((prefix) => right.startsWith(prefix));
      const leftRank = leftPriority === -1 ? PRIORITY_PREFIXES.length : leftPriority;
      const rightRank = rightPriority === -1 ? PRIORITY_PREFIXES.length : rightPriority;

      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return left.localeCompare(right);
    });

    return unique;
  }

  globalThis.EmailParserUtils = {
    decodeCloudflareEmail,
    decodeHtmlEntities,
    deobfuscateText,
    extractFromText,
    normalizeText,
    sanitizeCandidate,
    sortByBusinessPriority
  };
})();
