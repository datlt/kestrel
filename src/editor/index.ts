// Editor engine. Owner: editor engine. See docs/DESIGN.md, section 7.2.

import './tokens.css';
import './editor.css';
import type { AppContext, EditorService } from '../core/types';
import { EditorEngine } from './service';

export function createEditorService(ctx: AppContext): EditorService {
  return new EditorEngine(ctx);
}
