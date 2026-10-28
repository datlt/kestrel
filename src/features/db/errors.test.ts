import { describe, expect, it } from 'vitest';
import { describeError, isAuthError } from './errors';

describe('describeError', () => {
  it('reads server errors', () => {
    const info = describeError({ code: 'db_error', message: "1146 (42S02): Table 'x.y' doesn't exist" });
    expect(info).toMatchObject({ kind: 'server', number: 1146, sqlstate: '42S02' });
  });
  it('keeps the text when there is no prefix', () => {
    expect(describeError({ code: 'db_error', message: 'odd' })).toMatchObject({ kind: 'server', number: null, text: 'odd' });
  });
  it('maps the other codes', () => {
    expect(describeError({ code: 'db_connect', message: 'x' }).kind).toBe('connect');
    expect(describeError({ code: 'db_busy', message: 'x' }).kind).toBe('busy');
    expect(describeError({ code: 'db_lost', message: 'x' }).kind).toBe('lost');
    expect(describeError({ code: 'cancelled', message: 'x' }).kind).toBe('cancelled');
    expect(describeError({ code: 'db_auth', message: 'x' }).kind).toBe('auth');
    expect(describeError(new Error('boom'))).toMatchObject({ kind: 'other', text: 'boom' });
    expect(describeError('plain').text).toBe('plain');
  });
});

describe('isAuthError', () => {
  it('detects login failures', () => {
    expect(isAuthError({ code: 'db_connect', message: "1045 (28000): Access denied for user 'root'@'x' (using password: YES)" })).toBe(true);
    expect(isAuthError({ code: 'db_connect', message: "Access denied for user 'a'" })).toBe(true);
  });
  it('detects the code db_auth', () => {
    expect(isAuthError({ code: 'db_auth', message: 'HTTP 401 Unauthorized' })).toBe(true);
  });
  it('ignores other problems', () => {
    expect(isAuthError({ code: 'db_connect', message: 'connection refused' })).toBe(false);
    expect(isAuthError({ code: 'db_lost', message: 'Access denied' })).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });
});
