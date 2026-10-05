/** Normalises one order's values into runner options, whatever channel carried them (Plan_63 D5). */
import path from 'node:path';

export function orderOptions(agentType, order, { cwd = process.cwd() } = {}) {
  const options = { orderId: (order.get('order id') ?? '').trim() };
  const problems = [];
  // Left unset when absent: the role's configured profile fills the gap, and a default here would always win.
  // Plan_56 step 3 leaves effort support to the live catalogue and Codex at run start.
  if (order.has('effort')) {
    options.effort = order.get('effort');
    if (!options.effort || /\s/.test(options.effort)) {
      problems.push({ label: 'effort',
        reason: `must be a non-empty single word with no whitespace; got ${JSON.stringify(options.effort)}` });
    }
  }
  options.repo = path.resolve(order.get('repository') || cwd);
  options.slug = (order.get('slug') || options.orderId).replace(/[^A-Za-z0-9._-]+/g, '-');
  // Plan_29 incident: a generic slug let an honest order inherit a days-old chain.
  if (!/[A-Za-z0-9]/.test(options.slug)) {
    problems.push({ label: order.has('slug') ? 'slug' : 'order id',
      reason: `produces an unusable run folder name after sanitization: ${JSON.stringify(options.slug)} must contain a letter or digit.` });
  }
  options.changeset = order.get('changeset') || 'uncommitted';
  const declaredScopePatterns = (order.get('scope') || '').split(',').map((p) => p.trim()).filter(Boolean);
  options.scopeNewPatterns = (order.get('scope new') || '').split(',').map((p) => p.trim()).filter(Boolean);
  // Plan_27 keeps ordinary patterns strict: only paths named explicitly as new may be absent.
  options.scopePatterns = [...declaredScopePatterns, ...options.scopeNewPatterns];
  if (order.has('phase')) options.phase = order.get('phase');
  return { options, problems };
}
