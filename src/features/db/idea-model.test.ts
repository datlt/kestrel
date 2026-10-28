import { describe, expect, it } from 'vitest';
import type { DbConnectionConfig } from '../../ipc/db';
import { copyForSaving, ideaFilesChanged, ideaGroupLabel, isIdeaId, runLimited } from './idea-model';

const cfg: DbConnectionConfig = {
  id: 'idea:u-1',
  name: 'main@real',
  host: 'db.example.test',
  port: 3306,
  user: 'bob',
  ssl: 'preferred',
  readOnly: true,
  production: true,
  source: { kind: 'idea', projectRoot: '/work/app', uuid: 'u-1' },
};

describe('ideaFilesChanged', () => {
  it('sees the data source files of the open folder', () => {
    expect(ideaFilesChanged('/work/app', ['/work/app/.idea/dataSources.xml'])).toBe(true);
    expect(ideaFilesChanged('/work/app/', ['/work/app/.idea/dataSources.local.xml'])).toBe(true);
    expect(ideaFilesChanged('/work/app', ['/work/app/.idea/sshConfigs.xml'])).toBe(true);
    expect(ideaFilesChanged('C:\\work\\app', ['C:\\work\\app\\.idea\\dataSources.xml'])).toBe(true);
  });
  it('ignores other files', () => {
    expect(ideaFilesChanged('/work/app', ['/work/app/.idea/workspace.xml'])).toBe(false);
    expect(ideaFilesChanged('/work/app', ['/work/app/.idea/dataSources/x.xml'])).toBe(false);
    expect(ideaFilesChanged('/work/app', ['/work/app/src/dataSources.xml'])).toBe(false);
    expect(ideaFilesChanged('/work/app', ['/work/other/.idea/dataSources.xml'])).toBe(false);
  });
});

describe('copyForSaving', () => {
  it('drops the source and gets a new id', () => {
    const copy = copyForSaving(cfg, 'new-id', []);
    expect(copy.id).toBe('new-id');
    expect(copy.source).toBeUndefined();
    expect('source' in copy).toBe(false);
    expect(copy.name).toBe('main@real');
    expect(copy.production && copy.readOnly).toBe(true);
    expect(copy.host).toBe('db.example.test');
  });
  it('changes the name when it is taken', () => {
    expect(copyForSaving(cfg, 'x', ['main@real']).name).toBe('main@real copy');
  });
});

describe('small helpers', () => {
  it('knows idea ids', () => {
    expect(isIdeaId('idea:u-1')).toBe(true);
    expect(isIdeaId('3f2a')).toBe(false);
    expect(isIdeaId(null)).toBe(false);
  });
  it('names the group', () => {
    expect(ideaGroupLabel('app')).toBe('IntelliJ: app');
  });
  it('runs at most `limit` jobs at the same time and keeps going after an error', async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await runLimited([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      if (n === 3) throw new Error('boom');
      done.push(n);
    });
    expect(peak).toBe(4);
    expect(done).toHaveLength(8);
  });
  it('handles an empty list', async () => {
    await runLimited([], 4, async () => undefined);
  });
});
