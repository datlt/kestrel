import { describe, expect, it } from 'vitest';
import { classify, lineOf, oneLine, splitStatements, statementAt } from './split';

const texts = (s: string) => splitStatements(s).map((x) => x.text);

describe('splitStatements', () => {
  it('splits on semicolons and trims', () => {
    expect(texts('select 1;  select 2 ;\nselect 3')).toEqual(['select 1', 'select 2', 'select 3']);
  });

  it('returns nothing for empty text and comment-only text', () => {
    expect(texts('')).toEqual([]);
    expect(texts('  \n ; ; ')).toEqual([]);
    expect(texts('-- only a comment\n# another\n/* block */')).toEqual([]);
  });

  it('ignores semicolons in quotes', () => {
    expect(texts(`select 'a;b'; select "c;d"; select \`e;f\``)).toEqual([`select 'a;b'`, `select "c;d"`, 'select `e;f`']);
  });

  it('handles escaped and doubled quotes', () => {
    expect(texts(`select 'it\\'s; ok'; select 'it''s; ok'; select 2`)).toEqual([
      `select 'it\\'s; ok'`,
      `select 'it''s; ok'`,
      'select 2',
    ]);
    expect(texts('select "a""b;c"; select 1')).toEqual(['select "a""b;c"', 'select 1']);
    expect(texts('select `a``b;c`; select 1')).toEqual(['select `a``b;c`', 'select 1']);
  });

  it('ends a string at the matching quote after a double backslash', () => {
    expect(texts(`select 'a\\\\'; select 2`)).toEqual([`select 'a\\\\'`, 'select 2']);
  });

  it('skips line comments', () => {
    expect(texts('select 1 -- a; b\n; select 2')).toEqual(['select 1', 'select 2']);
    expect(texts('select 1 # a; b\n; select 2')).toEqual(['select 1', 'select 2']);
  });

  it('needs a space after -- to start a comment', () => {
    // `1--1` is arithmetic in MySQL, so the semicolon still ends the statement.
    expect(texts('select 1--1; select 2')).toEqual(['select 1--1', 'select 2']);
    expect(texts('select 1--\n; select 2')).toEqual(['select 1', 'select 2']);
    expect(texts('select 1 --')).toEqual(['select 1']);
  });

  it('skips block comments and keeps comments inside a statement', () => {
    expect(texts('select /* a; b */ 1; select 2')).toEqual(['select /* a; b */ 1', 'select 2']);
    expect(texts('/* head */ select 1;')).toEqual(['select 1']);
  });

  it('survives an unterminated string or comment', () => {
    expect(texts("select 'abc; select 2")).toEqual(["select 'abc; select 2"]);
    expect(texts('select 1; /* open ; select 2')).toEqual(['select 1']);
  });

  it('treats executable comments as code', () => {
    expect(texts('/*!40101 SET NAMES utf8 */; select 1')).toEqual(['/*!40101 SET NAMES utf8 */', 'select 1']);
  });

  it('follows DELIMITER lines', () => {
    const sql = [
      'select 1;',
      'DELIMITER $$',
      'create procedure p()',
      'begin',
      '  select 1;',
      '  select 2;',
      'end$$',
      'delimiter ;',
      'select 3;',
    ].join('\n');
    expect(texts(sql)).toEqual(['select 1', 'create procedure p()\nbegin\n  select 1;\n  select 2;\nend', 'select 3']);
  });

  it('accepts a multi-character delimiter and CRLF', () => {
    expect(texts('delimiter //\r\nselect 1; select 2//\r\ndelimiter ;\r\nselect 3;')).toEqual(['select 1; select 2', 'select 3']);
  });

  it('does not treat the word delimiter inside a statement as a command', () => {
    expect(texts('select 1\ndelimiter $$\n; select 2')).toEqual(['select 1\ndelimiter $$', 'select 2']);
  });

  it('gives exact offsets', () => {
    const src = '  select 1 ; select 2';
    const [a, b] = splitStatements(src);
    expect(src.slice(a.from, a.to)).toBe('select 1');
    expect(src.slice(a.to, a.end)).toBe(' ;');
    expect(src.slice(b.from, b.to)).toBe('select 2');
    expect(b.end).toBe(src.length);
  });

  it('keeps non-ASCII text', () => {
    expect(texts("select '日本語;テスト'; select 2")).toEqual(["select '日本語;テスト'", 'select 2']);
  });
});

describe('statementAt', () => {
  const src = 'select 1;\nselect 2;\n\nselect 3';
  const at = (pos: number) => statementAt(src, pos)?.text;

  it('finds the statement under the cursor', () => {
    expect(at(0)).toBe('select 1');
    expect(at(4)).toBe('select 1');
    expect(at(src.indexOf('select 2') + 3)).toBe('select 2');
    expect(at(src.length)).toBe('select 3');
  });

  it('picks the statement before the cursor when it stands right after the delimiter', () => {
    expect(at(9)).toBe('select 1');
  });

  it('picks the previous statement in a blank gap', () => {
    expect(at(src.indexOf('\n\n') + 1)).toBe('select 2');
  });

  it('picks the next statement when there is no previous one', () => {
    expect(statementAt('\n\n  select 1', 0)?.text).toBe('select 1');
  });

  it('returns null for text without statements', () => {
    expect(statementAt('  -- nothing', 3)).toBeNull();
  });

  it('works with a delimiter change', () => {
    const s = 'delimiter $$\nbegin select 1; end$$\nselect 2$$';
    expect(statementAt(s, s.indexOf('select 1'))?.text).toBe('begin select 1; end');
  });
});

describe('classify', () => {
  const kind = (s: string) => classify(s).kind;

  it('knows read statements', () => {
    for (const s of ['select 1', 'SELECT * FROM t', 'show tables', 'DESCRIBE t', 'desc t', 'explain select 1', '  \n select 1 for update']) {
      expect(kind(s), s).toBe('read');
    }
  });

  it('skips leading comments', () => {
    expect(kind('/* c */ -- x\nselect 1')).toBe('read');
    expect(kind('# x\ndelete from t')).toBe('write');
  });

  it('handles WITH', () => {
    expect(kind('with a as (select 1) select * from a')).toBe('read');
    expect(kind('with a as (select 1) delete from t where id in (select * from a)')).toBe('write');
    expect(classify('with a as (select 1) update t set x = 1').verb).toBe('UPDATE');
  });

  it('knows writes', () => {
    for (const s of ['insert into t values (1)', 'update t set a=1 where id=1', 'delete from t', 'drop table t', 'truncate t', 'create table t (id int)', 'alter table t add x int', 'call p()', 'replace into t values (1)']) {
      expect(kind(s), s).toBe('write');
    }
  });

  it('treats EXPLAIN ANALYZE of a write as a write', () => {
    expect(kind('explain analyze select 1')).toBe('read');
    expect(kind('explain analyze delete from t where id = 1')).toBe('write');
  });

  it('knows session statements', () => {
    for (const s of ['use db', 'set @a = 1', 'begin', 'start transaction', 'commit', 'rollback', 'savepoint x']) {
      expect(kind(s), s).toBe('session');
    }
  });

  it('is not fooled by keywords in strings, comments and names', () => {
    expect(kind("select 'delete from t'")).toBe('read');
    expect(kind('select 1 /* update t */')).toBe('read');
    expect(kind('select t.delete from t')).toBe('read');
  });

  it('treats unknown and executable-comment text as a write', () => {
    expect(kind('/*!40101 SET x=1 */')).toBe('write');
    expect(kind('flush privileges')).toBe('write');
  });

  it('reports empty text', () => {
    expect(kind('   ')).toBe('empty');
    expect(kind('-- hi')).toBe('write'); // comment only: no keyword, but not blank text
  });

  it('finds UPDATE and DELETE without WHERE', () => {
    expect(classify('update t set a = 1').noWhere).toBe(true);
    expect(classify('delete from t').noWhere).toBe(true);
    expect(classify('DELETE FROM t LIMIT 10').noWhere).toBe(true);
    expect(classify('update t set a = 1 where id = 1').noWhere).toBe(false);
    expect(classify('delete from t where 1=1').noWhere).toBe(false);
    expect(classify('update t set a = (select max(x) from u where u.id = 1)').noWhere).toBe(true);
    expect(classify("update t set a = 'where' ").noWhere).toBe(true);
    expect(classify('update t set a = 1 -- where\n').noWhere).toBe(true);
    expect(classify('select * from t').noWhere).toBe(false);
    expect(classify('insert into t select * from u').noWhere).toBe(false);
  });
});

describe('helpers', () => {
  it('oneLine cuts and joins', () => {
    expect(oneLine('select\n  1')).toBe('select 1');
    expect(oneLine('a'.repeat(100), 10)).toBe('aaaaaaaaa…');
  });
  it('lineOf counts lines', () => {
    expect(lineOf('a\nb\nc', 0)).toBe(1);
    expect(lineOf('a\nb\nc', 4)).toBe(3);
  });
});
