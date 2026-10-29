// Web Worker: runs the force simulation (`sim-core.ts`) off the main thread.
//
// It posts the positions after every step as a Float32Array (moved, not
// copied). It stops by itself when the simulation has cooled down. Each
// message of the page carries a generation number. Answers carry it back, so
// the page can ignore answers of an old graph.

import { Sim } from './sim-core';
import type { SimInit, SimParams } from './sim-core';

export type SimRequest =
  | { type: 'init'; gen: number; init: SimInit }
  | { type: 'params'; gen: number; params: SimParams; reheat: number }
  | { type: 'radius'; gen: number; radius: Float32Array }
  | { type: 'reheat'; gen: number; alpha: number }
  | { type: 'pin'; gen: number; index: number; x: number; y: number }
  | { type: 'unpin'; gen: number; index: number }
  | { type: 'stop'; gen: number };

export type SimResponse = { type: 'tick'; gen: number; pos: Float32Array; alpha: number } | { type: 'end'; gen: number; pos: Float32Array; alpha: number };

const scope = self as unknown as { postMessage(m: SimResponse, t?: Transferable[]): void; onmessage: ((e: MessageEvent<SimRequest>) => void) | null };

let sim: Sim | null = null;
let gen = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Time between two answers, in ms (about 60 per second). */
const FRAME_MS = 16;

function post(type: 'tick' | 'end'): void {
  if (!sim) return;
  const pos = sim.positions();
  scope.postMessage({ type, gen, pos, alpha: sim.alpha }, [pos.buffer]);
}

function run(): void {
  timer = undefined;
  if (!sim) return;
  const t0 = performance.now();
  sim.tick();
  if (sim.active()) {
    post('tick');
    timer = setTimeout(run, Math.max(0, FRAME_MS - (performance.now() - t0)));
  } else {
    post('end');
  }
}

function schedule(): void {
  if (timer === undefined) timer = setTimeout(run, 0);
}

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    gen = msg.gen;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    sim = new Sim(msg.init);
    post('tick');
    schedule();
    return;
  }
  if (msg.gen !== gen || !sim) return;
  switch (msg.type) {
    case 'params':
      sim.setParams(msg.params);
      sim.reheat(msg.reheat);
      schedule();
      break;
    case 'radius':
      sim.setRadius(msg.radius);
      break;
    case 'reheat':
      sim.reheat(msg.alpha);
      schedule();
      break;
    case 'pin':
      sim.pin(msg.index, msg.x, msg.y);
      schedule();
      break;
    case 'unpin':
      sim.unpin(msg.index);
      schedule();
      break;
    case 'stop':
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      break;
  }
};
