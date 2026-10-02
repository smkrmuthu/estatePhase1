// Document numbers like RCV-2026-00042. Each prefix + year has its own counter per
// organisation. A failed posting can leave a gap in the sequence; numbers are
// never reused.
export async function nextNo(db: D1Database, orgId: string, prefix: string, date: string): Promise<string> {
  const key = `${prefix}-${date.slice(0, 4)}`;
  const row = await db
    .prepare('INSERT INTO counters (org_id, key, value) VALUES (?, ?, 1) ON CONFLICT (org_id, key) DO UPDATE SET value = value + 1 RETURNING value')
    .bind(orgId, key)
    .first<{ value: number }>();
  return `${key}-${String(row!.value).padStart(5, '0')}`;
}

export const TXN_PREFIX = { OPENING: 'OPN', RECEIPT: 'RCV', TRANSFER: 'TRF', ADJUSTMENT: 'ADJ', DISPATCH: 'DSP', REVERSAL: 'REV' } as const;
