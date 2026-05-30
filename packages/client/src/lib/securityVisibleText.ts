const SUSPICIOUS_UNICODE_NAMES: Record<number, string> = {
  0x061c: "ALM",
  0x180e: "MVS",
  0x200b: "ZWSP",
  0x200c: "ZWNJ",
  0x200d: "ZWJ",
  0x200e: "LRM",
  0x200f: "RLM",
  0x202a: "LRE",
  0x202b: "RLE",
  0x202c: "PDF",
  0x202d: "LRO",
  0x202e: "RLO",
  0x2060: "WJ",
  0x2061: "FA",
  0x2062: "IT",
  0x2063: "IS",
  0x2064: "IP",
  0x2066: "LRI",
  0x2067: "RLI",
  0x2068: "FSI",
  0x2069: "PDI",
  0xfeff: "BOM",
};

function isSecuritySensitiveCodePoint(codePoint: number): boolean {
  if (codePoint <= 0x1f) {
    return codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d;
  }
  if (codePoint >= 0x7f && codePoint <= 0x9f) return true;
  if (codePoint >= 0x200b && codePoint <= 0x200f) return true;
  if (codePoint >= 0x202a && codePoint <= 0x202e) return true;
  if (codePoint >= 0x2060 && codePoint <= 0x206f) return true;
  return codePoint === 0x061c || codePoint === 0x180e || codePoint === 0xfeff;
}

function describeCodePoint(codePoint: number): string {
  const hex = codePoint.toString(16).toUpperCase().padStart(4, "0");
  const name = SUSPICIOUS_UNICODE_NAMES[codePoint] ?? "CTRL";
  return `[U+${hex} ${name}]`;
}

export function makeSecurityVisibleText(text: string): string {
  let changed = false;
  const visible = Array.from(text, (char) => {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || !isSecuritySensitiveCodePoint(codePoint)) {
      return char;
    }
    changed = true;
    return describeCodePoint(codePoint);
  }).join("");

  return changed ? visible : text;
}

export function makeSecurityVisibleValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") {
    return makeSecurityVisibleText(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => makeSecurityVisibleValue(item, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      makeSecurityVisibleText(key),
      makeSecurityVisibleValue(entry, seen),
    ]),
  );
}
