// SVG preview: draws the text of the editor as an image.

import type { PreviewInstance } from '../../core/types';
import { ImageView } from './image-view';
import './preview.css';

export function createSvgPreview(host: HTMLElement): PreviewInstance {
  const view = new ImageView({ upscale: true });
  host.append(view.el);
  let url: string | null = null;
  let first = true;
  return {
    update(text) {
      const next = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
      if (url) URL.revokeObjectURL(url);
      url = next;
      // After the first load, keep the zoom and position while the user types.
      view.setSrc(next, !first);
      first = false;
    },
    zoom: (step) => view.zoom(step),
    dispose() {
      if (url) URL.revokeObjectURL(url);
      view.dispose();
    },
  };
}
