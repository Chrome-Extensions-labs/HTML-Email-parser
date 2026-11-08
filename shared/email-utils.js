/**
 * Pure email parsing helpers.
 *
 * The module deliberately has no DOM dependency: entity decoding used to create
 * a detached <textarea> per candidate, which allocated a node for every text
 * node and attribute of the page. Keeping this layer pure also makes the
 * extraction rules testable in Node without a browser.
 */
(() => {
  "use strict";

  const MAX_TEXT_LENGTH = 100_000;
  const MAX_CANDIDATE_LENGTH = 2_048;
  const MAX_MATCHES_PER_PASS = 256;
  const MAX_EMAIL_LENGTH = 254; // RFC 5321 forward-path limit.
  const MAX_LOCAL_PART_LENGTH = 64;

  /**
   * Every repetition is bounded by the corresponding RFC 5321 limit. Unbounded
   * `+` quantifiers here cause quadratic backtracking on long runs of letters,
   * which is realistic on minified pages and script blocks.
   */
  const EMAIL_PATTERN =
    "[A-Z0-9._%+-]{1,64}@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\\.){1,8}[A-Z]{2,24}";
  const PLAIN_RE = new RegExp(`(?:${EMAIL_PATTERN})\\b`, "gi");
  const CANDIDATE_RE = new RegExp(EMAIL_PATTERN, "i");

  /**
   * Common anti-scraping spellings. Spelled-out separators are matched only in
   * email-shaped fragments, never applied to the whole document: rewriting
   * "contact us at www.example.com" would otherwise invent a mailbox.
   */
  const DOT_TOKEN = "(?:\\[dot\\]|\\(dot\\)|\\s+dot\\s+|・|\\[\\.\\]|\\\\\\.)";
  const OBFUSCATED_EXPLICIT_RE = new RegExp(
    "[A-Z0-9._%+\\-]{1,64}\\s*" +
      "(?:\\[at\\]|\\(at\\)|\\{at\\}|@|＠)\\s*" +
      "[A-Z0-9-]{1,63}" +
      `(?:\\s*(?:\\.|${DOT_TOKEN})\\s*[A-Z0-9-]{1,63}){1,8}`,
    "gi"
  );
  const OBFUSCATED_SPACED_RE = new RegExp(
    "[A-Z0-9._%+\\-]{1,64}\\s+at\\s+" +
      "[A-Z0-9-]{1,63}" +
      `(?:\\s*${DOT_TOKEN}\\s*[A-Z0-9-]{1,63}){1,8}`,
    "gi"
  );

  /** Avoids running the regex pipeline on fragments that cannot contain an address. */
  const EMAIL_HINT_RE = /@|＠|&#64;|%40|\[at\]|\(at\)|\{at\}|\s+at\s+/i;

  const CONCATENATION_RE =
    /(?:["'`][^"'`]{1,80}["'`]\s*\+\s*){1,8}["'`][^"'`]{1,80}["'`]/g;
  const QUOTED_PART_RE = /(["'`])([^"'`]*)\1/g;
  const ENTITY_RE = /&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]{1,31});?/gi;
  const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
  const AT_TOKEN_RE = /\[at\]|\(at\)|\{at\}|\s+at\s+|＠/gi;
  const DOT_TOKEN_RE = /\[dot\]|\(dot\)|\s+dot\s+|\\\.|・|\[\.\]|\s+\.\s+/gi;
  const ASSET_SUFFIX_RE =
    /\.(?:jpe?g|png|gif|webp|avif|svg|bmp|ico|tiff|js|css|json|woff2?|map|min)(?:$|[^a-z0-9])/i;
  const EXACT_EMAIL_RE =
    /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

  const NAMED_ENTITIES = Object.freeze({
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    commat: "@",
    at: "@",
    period: ".",
    dot: ".",
    sol: "/"
  });

  /** Prefixes ordered by business value; earlier entries rank higher. */
  const PRIORITY_PREFIXES = Object.freeze([
    "ads@", "ad@", "advertising@", "advertise@", "marketing@", "partnerships@",
    "partners@", "business@", "publisher@", "sales@", "sale@", "ap@", "apps@",
    "app@", "web@", "webmaster@", "contact@", "contactus@", "website@",
    "games@", "game@", "ceo@", "info@", "hello@", "general@", "press@",
    "community@", "tech@", "accounts@", "no-reply@", "noreply@", "appcrm@",
    "orders@", "service@", "support@", "help@", "tips@", "letters@", "admin@",
    "app.contact@", "app.support@", "postmaster@", "notifications@",
    "information@"
  ]);

  function decodeHtmlEntities(raw) {
    if (typeof raw !== "string" || raw.indexOf("&") === -1) {
      return typeof raw === "string" ? raw : "";
    }

    return raw.replace(ENTITY_RE, (match, entity) => {
      if (entity.charAt(0) === "#") {
        const isHex = entity.charAt(1) === "x" || entity.charAt(1) === "X";
        const codePoint = Number.parseInt(
          isHex ? entity.slice(2) : entity.slice(1),
          isHex ? 16 : 10
        );
        if (!Number.isFinite(codePoint) || codePoint < 1 || codePoint > 0x10FFFF) {
          return match;
        }
        return String.fromCodePoint(codePoint);
      }

      const decoded = NAMED_ENTITIES[entity.toLowerCase()];
      return decoded === undefined ? match : decoded;
    });
  }

  function normalizeText(raw) {
    if (typeof raw !== "string") {
      return "";
    }

    return raw
      .replace(INVISIBLE_RE, "")
      .replace(/＠/g, "@")
      .replace(/[．。・﹒｡]/g, ".")
      .replace(/[‘’‚‛`´]/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Rewrites obfuscation tokens within a single matched candidate. */
  function deobfuscateText(raw) {
    if (typeof raw !== "string") {
      return "";
    }

    return raw
      .replace(AT_TOKEN_RE, "@")
      .replace(DOT_TOKEN_RE, ".")
      .replace(/\s*@\s*/g, "@")
      .replace(/\s*\.\s*/g, ".")
      .replace(/[(),;]+$/g, "")
      .trim();
  }

  /** Rejects asset URLs and bundle artefacts that merely resemble addresses. */
  function isAssetLike(raw) {
    return typeof raw === "string" && ASSET_SUFFIX_RE.test(raw);
  }

  /**
   * Validates an already normalised address against conservative mailbox rules.
   * Characters that could be interpreted as mailto URL delimiters are rejected
   * up front because the popup interpolates addresses into href attributes.
   */
  function isValidEmail(raw) {
    if (typeof raw !== "string") {
      return false;
    }

    const email = raw.trim().toLowerCase();
    if (email.length < 6 || email.length > MAX_EMAIL_LENGTH) {
      return false;
    }

    if (!EXACT_EMAIL_RE.test(email)) {
      return false;
    }

    const [localPart, domainPart] = email.split("@");
    if (
      localPart.length > MAX_LOCAL_PART_LENGTH ||
      domainPart.length > 253 ||
      domainPart.startsWith("www.") ||
      /[?#&/]/.test(localPart) ||
      /^[0-9a-f]{12,}$/.test(localPart) ||
      /^\d{10,}$/.test(localPart) ||
      isAssetLike(email)
    ) {
      return false;
    }

    return true;
  }

  /** Normalises one raw value (attribute, text fragment or decoded token). */
  function sanitizeCandidate(raw) {
    if (typeof raw !== "string" || raw.length === 0) {
      return null;
    }

    let value = raw.slice(0, MAX_CANDIDATE_LENGTH);
    value = normalizeText(decodeHtmlEntities(value));

    const isMailto = /^mailto\s*:/i.test(value);
    value = value.replace(/^mailto\s*:/i, "");

    if (isMailto) {
      // Query parameters belong to the URL, not to the mailbox address.
      value = value.split(/[?#]/)[0];
      if (value.indexOf("%") !== -1) {
        try {
          value = decodeURIComponent(value);
        } catch {
          // Keep the raw value; a malformed escape must not abort the scan.
        }
      }
    }

    value = value
      .replace(/^[^A-Za-z0-9@]+/, "")
      .replace(/[^A-Za-z0-9@]+$/, "")
      .trim();

    const match = value.match(CANDIDATE_RE);
    if (!match) {
      return null;
    }

    const email = match[0].toLowerCase();
    return isValidEmail(email) ? email : null;
  }

  /** Decodes Cloudflare's XOR-obfuscated data-cfemail attribute. */
  function decodeCloudflareEmail(encoded) {
    if (
      typeof encoded !== "string" ||
      !/^[0-9a-f]+$/i.test(encoded) ||
      encoded.length < 4 ||
      encoded.length > 512 ||
      encoded.length % 2 !== 0
    ) {
      return null;
    }

    const key = Number.parseInt(encoded.slice(0, 2), 16);
    let decoded = "";

    for (let index = 2; index < encoded.length; index += 2) {
      const charCode = Number.parseInt(encoded.slice(index, index + 2), 16) ^ key;
      if (charCode < 0x20 || charCode > 0x7E) {
        return null;
      }
      decoded += String.fromCharCode(charCode);
    }

    return decoded;
  }

  function collectMatches(text, pattern, sink, limit, transform) {
    let inspected = 0;
    for (const match of text.matchAll(pattern)) {
      if (sink.size >= limit || inspected >= MAX_MATCHES_PER_PASS) {
        return;
      }
      inspected += 1;
      const raw = transform ? transform(match[0]) : match[0];
      const email = sanitizeCandidate(raw);
      if (email) {
        sink.add(email);
      }
    }
  }

  /** Recovers addresses assembled from JavaScript string concatenation. */
  function collectConcatenated(text, sink, limit) {
    let inspected = 0;
    for (const match of text.matchAll(CONCATENATION_RE)) {
      if (sink.size >= limit || inspected >= MAX_MATCHES_PER_PASS) {
        return;
      }
      inspected += 1;

      let joined = "";
      for (const part of match[0].matchAll(QUOTED_PART_RE)) {
        joined += part[2];
      }
      const email = sanitizeCandidate(joined);
      if (email) {
        sink.add(email);
      }
    }
  }

  /** Extracts every distinct, valid address from one bounded text fragment. */
  function extractFromText(rawText, limit = 50) {
    const foundEmails = new Set();
    if (typeof rawText !== "string" || rawText.length === 0 || limit <= 0) {
      return foundEmails;
    }

    const text = normalizeText(
      decodeHtmlEntities(rawText.slice(0, MAX_TEXT_LENGTH))
    );
    if (!EMAIL_HINT_RE.test(text)) {
      return foundEmails;
    }

    collectMatches(text, PLAIN_RE, foundEmails, limit);
    collectMatches(text, OBFUSCATED_EXPLICIT_RE, foundEmails, limit, deobfuscateText);
    collectMatches(text, OBFUSCATED_SPACED_RE, foundEmails, limit, deobfuscateText);
    if (text.includes("+") && /["'`]/.test(text)) {
      collectConcatenated(text, foundEmails, limit);
    }

    return foundEmails;
  }

  function priorityRank(email) {
    for (let index = 0; index < PRIORITY_PREFIXES.length; index += 1) {
      if (email.startsWith(PRIORITY_PREFIXES[index])) {
        return index;
      }
    }
    return PRIORITY_PREFIXES.length;
  }

  /** Deduplicates, validates and orders addresses by business relevance. */
  function sortByBusinessPriority(emails) {
    const unique = new Set();
    for (const value of Array.isArray(emails) ? emails : []) {
      if (typeof value !== "string") {
        continue;
      }
      const email = value.trim().toLowerCase();
      if (isValidEmail(email)) {
        unique.add(email);
      }
    }

    // Decorate/sort/undecorate computes each rank once instead of on every
    // comparator invocation.
    return Array.from(unique)
      .map((email) => ({ email, rank: priorityRank(email) }))
      .sort((left, right) => left.rank - right.rank || left.email.localeCompare(right.email))
      .map((entry) => entry.email);
  }

  const api = Object.freeze({
    decodeCloudflareEmail,
    decodeHtmlEntities,
    deobfuscateText,
    extractFromText,
    isValidEmail,
    normalizeText,
    sanitizeCandidate,
    sortByBusinessPriority
  });

  globalThis.EmailParserUtils = api;

  // The CommonJS reference exists solely for the Node-based unit tests.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
