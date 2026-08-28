const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
  /\b[A-Za-z0-9_-]{32,}\b/g,
];

export function redact(input: string | null | undefined, maxLength = 400): string {
  if (!input) return "";
  let text = input;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "[REDACTED]");
  }
  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + "…";
  }
  return text;
}