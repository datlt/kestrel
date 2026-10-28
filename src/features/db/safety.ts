// Decides when to ask before a statement runs (DESIGN 9.3, "Safety").
// No DOM code, so tests can import it.

import type { Settings } from '../../core/types';
import { classify, oneLine, type Stmt } from './split';

export interface SafetyInput {
  statements: readonly Pick<Stmt, 'text'>[];
  production: boolean;
  readOnly: boolean;
  confirmWrites: Settings['db.confirmWrites'];
}

export interface Confirmation {
  title: string;
  message: string;
  /** Statements without WHERE: the question never goes away. */
  noWhere: boolean;
}

/** Returns what to ask, or null when the statements can run at once. */
export function needsConfirmation(input: SafetyInput): Confirmation | null {
  const infos = input.statements.map((s) => ({ text: s.text, info: classify(s.text) }));
  const noWhere = infos.filter((x) => x.info.noWhere);
  const writes = infos.filter((x) => x.info.kind === 'write');
  const askForWrites =
    writes.length > 0 &&
    !input.readOnly &&
    (input.confirmWrites === 'always' || (input.confirmWrites === 'production' && input.production));

  if (noWhere.length === 0 && !askForWrites) return null;

  const lines: string[] = [];
  if (noWhere.length > 0) {
    lines.push(
      noWhere.length === 1
        ? 'This statement has no WHERE clause. It changes every row of the table:'
        : `${noWhere.length} statements have no WHERE clause. They change every row of their tables:`,
    );
    for (const x of noWhere.slice(0, 5)) lines.push(`  ${oneLine(x.text, 100)}`);
    if (noWhere.length > 5) lines.push(`  ... and ${noWhere.length - 5} more`);
  }
  if (askForWrites) {
    if (lines.length) lines.push('');
    const where = input.production ? 'This is a production connection. ' : '';
    lines.push(
      writes.length === 1
        ? `${where}The statement can change data or the schema:`
        : `${where}${writes.length} statements can change data or the schema. The first one:`,
    );
    if (noWhere.length === 0) lines.push(`  ${oneLine(writes[0].text, 100)}`);
    else lines.push('  (see above)');
  }
  return {
    title: noWhere.length > 0 ? 'Run a statement without WHERE?' : input.production ? 'Run on a production database?' : 'Run this statement?',
    message: lines.join('\n'),
    noWhere: noWhere.length > 0,
  };
}
