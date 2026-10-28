// The bottom panel view `db-results`: results of statements run from `.sql` files.

import type { ViewInstance } from '../../core/types';
import type { DbHub } from './hub';
import { ResultsPane } from './results-pane';
import './db.css';

export function createResultsPanel(hub: DbHub, host: HTMLElement): ViewInstance {
  host.classList.add('db-panel');
  const pane = new ResultsPane(hub.ctx, host, hub.panelStore, 'Run a statement in a .sql file with Mod-Enter. Results show here.');
  return {
    onShow: () => pane.refresh(),
    dispose: () => pane.dispose(),
  };
}
