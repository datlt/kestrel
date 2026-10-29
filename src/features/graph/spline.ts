// Draws a B-spline through control points, for the bundled links of the tree
// layouts. It is the same curve as `curveBasis` of d3-shape: it starts at the
// first point, ends at the last point, and bends toward the points between.

export interface PathLike {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
}

/** `pts` is x, y, x, y, ... Adds one open curve to `path`. */
export function appendBasis(path: PathLike, pts: ArrayLike<number>): void {
  const n = Math.floor(pts.length / 2);
  if (n < 2) return;
  path.moveTo(pts[0], pts[1]);
  if (n === 2) {
    path.lineTo(pts[2], pts[3]);
    return;
  }
  let x0 = pts[0];
  let y0 = pts[1];
  let x1 = pts[2];
  let y1 = pts[3];
  path.lineTo((5 * x0 + x1) / 6, (5 * y0 + y1) / 6);
  for (let i = 2; i < n; i++) {
    const x = pts[i * 2];
    const y = pts[i * 2 + 1];
    path.bezierCurveTo((2 * x0 + x1) / 3, (2 * y0 + y1) / 3, (x0 + 2 * x1) / 3, (y0 + 2 * y1) / 3, (x0 + 4 * x1 + x) / 6, (y0 + 4 * y1 + y) / 6);
    x0 = x1;
    y0 = y1;
    x1 = x;
    y1 = y;
  }
  path.bezierCurveTo((2 * x0 + x1) / 3, (2 * y0 + y1) / 3, (x0 + 2 * x1) / 3, (y0 + 2 * y1) / 3, (x0 + 5 * x1) / 6, (y0 + 5 * y1) / 6);
  path.lineTo(x1, y1);
}
