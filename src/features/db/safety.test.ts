import { describe, expect, it } from 'vitest';
import { needsConfirmation } from './safety';

const run = (sql: string[], over: Partial<Parameters<typeof needsConfirmation>[0]> = {}) =>
  needsConfirmation({
    statements: sql.map((text) => ({ text })),
    production: false,
    readOnly: false,
    confirmWrites: 'production',
    ...over,
  });

describe('needsConfirmation', () => {
  it('lets reads run everywhere', () => {
    expect(run(['select 1'], { production: true, confirmWrites: 'always' })).toBeNull();
    expect(run(['show tables', 'use db', 'begin'], { production: true, confirmWrites: 'always' })).toBeNull();
  });

  it('asks for writes on production with the default setting', () => {
    expect(run(['update t set a = 1 where id = 1'], { production: true })).not.toBeNull();
    expect(run(['update t set a = 1 where id = 1'], { production: false })).toBeNull();
  });

  it('follows the always and never settings', () => {
    expect(run(['insert into t values (1)'], { confirmWrites: 'always' })).not.toBeNull();
    expect(run(['insert into t values (1)'], { production: true, confirmWrites: 'never' })).toBeNull();
  });

  it('always asks for UPDATE or DELETE without WHERE', () => {
    for (const mode of ['production', 'always', 'never'] as const) {
      const c = run(['delete from t'], { confirmWrites: mode });
      expect(c?.noWhere, mode).toBe(true);
      expect(c?.title).toContain('without WHERE');
    }
  });

  it('skips the write question on a read-only connection but keeps the no-WHERE question', () => {
    expect(run(['insert into t values (1)'], { readOnly: true, production: true })).toBeNull();
    expect(run(['delete from t'], { readOnly: true })?.noWhere).toBe(true);
  });

  it('describes scripts', () => {
    const c = run(['select 1', 'insert into t values (1)', 'drop table x'], { production: true });
    expect(c?.message).toContain('2 statements');
    expect(c?.message).toContain('production');
  });

  it('lists statements without WHERE and cuts the list', () => {
    const c = run(Array.from({ length: 8 }, () => 'delete from t'));
    expect(c?.message).toContain('8 statements have no WHERE');
    expect(c?.message).toContain('and 3 more');
  });
});
