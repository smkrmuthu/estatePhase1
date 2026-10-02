// Package barcode values: "PKG-" + 10 Crockford Base32 characters + 1 check character.
// Crockford Base32 has no I/L/O/U, so codes typed by hand are not misread; the
// mod-37 check character rejects any single mistyped character.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CHECK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U';

function checkChar(payload: string): string {
  let sum = 0;
  for (const ch of payload) sum = (sum * 32 + B32.indexOf(ch)) % 37;
  return CHECK[sum];
}

export function newBarcodeValue(): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    const payload = Array.from(bytes, (b) => B32[b & 31]).join('');
    const check = checkChar(payload);
    if (/[A-Z0-9]/.test(check)) return `PKG-${payload}${check}`; // letters/digits only on labels
  }
}

// Normalises scanner/keyboard input and verifies the check character.
export function normaliseBarcode(input: string): { value: string; valid: boolean } {
  const raw = String(input || '').trim().toUpperCase().replace(/\s+/g, '');
  const m = raw.match(/^(?:PKG-?)?([0-9A-Z]{10})([0-9A-Z])$/);
  if (!m) return { value: raw, valid: false };
  const payload = m[1].replace(/O/g, '0').replace(/[IL]/g, '1');
  return { value: `PKG-${payload}${m[2]}`, valid: !payload.includes('U') && checkChar(payload) === m[2] };
}
