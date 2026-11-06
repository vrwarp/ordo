import type { PathSink } from './draw.ts';

/*
 * A Path2D for Node tests (Node has none): records what is traced into it. Install it with
 * `vi.stubGlobal('Path2D', RecPath)`.
 */
export class RecPath implements PathSink {
  readonly ops: string[] = [];
  moveTo(x: number, y: number): void {
    this.ops.push(`M ${x} ${y}`);
  }
  lineTo(x: number, y: number): void {
    this.ops.push(`L ${x} ${y}`);
  }
  quadraticCurveTo(a: number, b: number, x: number, y: number): void {
    this.ops.push(`Q ${a} ${b} ${x} ${y}`);
  }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number): void {
    this.ops.push(`C ${a} ${b} ${c} ${d} ${x} ${y}`);
  }
  closePath(): void {
    this.ops.push('Z');
  }
  addPath(p: RecPath): void {
    this.ops.push(...p.ops);
  }
  /** The points of every M, L and the end point of every Q and C, in order. */
  points(): [number, number][] {
    const out: [number, number][] = [];
    for (const op of this.ops) {
      const n = op.split(' ').slice(1).map(Number);
      if (n.length >= 2) out.push([n[n.length - 2]!, n[n.length - 1]!]);
    }
    return out;
  }
}
