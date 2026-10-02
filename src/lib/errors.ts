// One error shape for every failure: { error: { code, message, field? } }.

export class ApiError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 422 | 429, public code: string, message: string, public field?: string) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`);
export const invalid = (message: string, field?: string) => new ApiError(422, 'validation_error', message, field);
export const conflict = (message: string) => new ApiError(409, 'conflict', message);

// Messages raised by the database triggers in migrations/0001_stock_rules.sql.
const RULE_MESSAGES: Record<string, [409 | 422, string]> = {
  insufficient_stock: [409, 'Not enough stock available for this posting (someone may have just used it). Refresh and try again.'],
  ledger_immutable: [409, 'Posted stock records cannot be changed. Reverse the transaction instead.'],
  not_reversible: [409, 'This transaction has already been reversed or cannot be reversed.'],
  dispatch_not_postable: [409, 'This dispatch was already posted, or its packages do not add up to the line totals.'],
  dispatch_not_draft: [409, 'This dispatch is no longer a draft, so it cannot be changed.'],
  barcode_immutable: [409, 'Package barcodes cannot be changed or removed.'],
  cross_org: [422, 'Record belongs to a different organisation.'],
  audit_immutable: [409, 'Audit records cannot be changed.']
};

// Maps a D1 error from a trigger or constraint to an ApiError, or returns null.
export function fromDbError(err: unknown): ApiError | null {
  const text = String((err as { message?: string })?.message ?? err) + ' ' + String((err as { cause?: { message?: string } })?.cause?.message ?? '');
  const rule = text.match(/ESTATE:([a-z_]+)/);
  if (rule && RULE_MESSAGES[rule[1]]) {
    const [status, message] = RULE_MESSAGES[rule[1]];
    return new ApiError(status, rule[1], message);
  }
  if (/UNIQUE constraint failed/i.test(text)) return conflict('That code or number is already in use.');
  return null;
}
