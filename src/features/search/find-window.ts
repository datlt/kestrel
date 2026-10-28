// What the popup hands to the sidebar Search view ("Open in Find Window").

import type { SearchContext } from '../../ipc/search';
import type { ResultFile } from './results';
import type { ScopeSpec } from './scope';
import type { FindOptions } from './state';

export interface FindWindowPayload {
  query: string;
  options: FindOptions;
  context: SearchContext;
  /** Text for the "files to include" field of the view. */
  include: string;
  /** Text for the "files to exclude" field of the view. */
  exclude: string;
  /** Folder, file list and filters that the view keeps for its next searches. */
  scope: ScopeSpec;
  files: ResultFile[];
  truncated: boolean;
}
