/**
 * Walker/Vose alias method sampler, constructed exactly like the BC-UR reference
 * (`random-sampler.cpp`) so that fountain code fragment selection is interoperable.
 */
export class RandomSampler {
  private readonly probs: number[];
  private readonly aliases: number[];

  constructor(weights: readonly number[]) {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (!(sum > 0) || weights.some((w) => w < 0)) throw new RangeError('Invalid sampler weights');
    const n = weights.length;
    const p = weights.map((w) => (w * n) / sum);
    const small: number[] = [];
    const large: number[] = [];
    for (let i = n - 1; i >= 0; i--) {
      if (p[i]! < 1) small.push(i);
      else large.push(i);
    }
    const probs = new Array<number>(n).fill(0);
    const aliases = new Array<number>(n).fill(0);
    while (small.length > 0 && large.length > 0) {
      const a = small.pop()!;
      const g = large.pop()!;
      probs[a] = p[a]!;
      aliases[a] = g;
      p[g] = p[g]! + p[a]! - 1;
      if (p[g]! < 1) small.push(g);
      else large.push(g);
    }
    while (large.length > 0) probs[large.pop()!] = 1;
    // Only reachable through floating point rounding.
    while (small.length > 0) probs[small.pop()!] = 1;
    this.probs = probs;
    this.aliases = aliases;
  }

  next(rng: () => number): number {
    const r1 = rng();
    const r2 = rng();
    const i = Math.floor(this.probs.length * r1);
    return r2 < this.probs[i]! ? i : this.aliases[i]!;
  }
}
