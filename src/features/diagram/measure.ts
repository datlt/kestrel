// Measures text widths with a canvas. Each diagram view has its own cache.

import type { Measure } from './node-box';

export function createMeasure(fontFamily: string): Measure {
  const canvas = document.createElement('canvas');
  const c = canvas.getContext('2d');
  const cache = new Map<string, number>();
  return (text, size, bold) => {
    const key = `${size}|${bold ? 1 : 0}|${text}`;
    let w = cache.get(key);
    if (w === undefined) {
      if (c) {
        c.font = `${bold ? 700 : 400} ${size}px ${fontFamily}`;
        w = c.measureText(text).width;
      } else {
        w = text.length * size * 0.6;
      }
      cache.set(key, w);
    }
    return w;
  };
}
