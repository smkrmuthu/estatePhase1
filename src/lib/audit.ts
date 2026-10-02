import { newId, nowIso } from '../db';

// Returns a prepared statement so it can join the same all-or-nothing batch as the change it records.
export function auditStmt(db: D1Database, orgId: string, entity: string, entityId: string, action: string, summary: string, actorId: string) {
  return db
    .prepare('INSERT INTO audit_log (id, org_id, entity, entity_id, action, summary, actor_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(newId(), orgId, entity, entityId, action, summary.slice(0, 500), actorId, nowIso());
}
