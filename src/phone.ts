/** Best-effort normalization for common US input shapes before E.164 validation.
 * "6072167113" -> "+16072167113", "16072167113" -> "+16072167113". Anything
 * already starting with "+" (or anything else) passes through unchanged so a
 * genuinely invalid number still fails validation with a clear error. */
export function normalizePhone(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return trimmed;
}

export function isE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}
