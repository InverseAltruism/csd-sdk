// A binary min-heap of (key, id) entries, popped in key order (ties in push order). Entries are never removed early:
// the reader re-checks the item an entry names when it pops, so a closed or re-keyed item leaves a stale entry behind.
export class MinQueue {
  private readonly keys: number[] = [];
  private readonly seqs: number[] = [];
  private readonly ids: string[] = [];
  private pushed = 0;

  get size(): number { return this.ids.length; }

  /** The smallest stored key, or undefined when the queue is empty. */
  peekKey(): number | undefined { return this.keys[0]; }

  /** Adds an entry. A NaN key is not stored: no comparison with NaN is true, so such an item is never due. */
  push(key: number, id: string): void {
    if (key !== key) return;
    let i = this.ids.length;
    this.keys.push(key); this.seqs.push(++this.pushed); this.ids.push(id);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p); i = p;
    }
  }

  /** Removes every entry whose key is below `limit` and appends its id to `out`, smallest key first. */
  popBelow(limit: number, out: string[]): void {
    while (this.ids.length > 0 && this.keys[0]! < limit) {
      out.push(this.ids[0]!);
      this.swap(0, this.ids.length - 1);
      this.keys.pop(); this.seqs.pop(); this.ids.pop();
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.ids.length && this.less(l, m)) m = l;
        if (r < this.ids.length && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
  }

  /** Every stored (key, id), in no particular order: for the replay's check mode. */
  *entries(): IterableIterator<[number, string]> {
    for (let i = 0; i < this.ids.length; i++) yield [this.keys[i]!, this.ids[i]!];
  }

  private less(i: number, j: number): boolean {
    const a = this.keys[i]!, b = this.keys[j]!;
    return a < b || (a === b && this.seqs[i]! < this.seqs[j]!);
  }

  private swap(i: number, j: number): void {
    const k = this.keys[i]!, s = this.seqs[i]!, d = this.ids[i]!;
    this.keys[i] = this.keys[j]!; this.seqs[i] = this.seqs[j]!; this.ids[i] = this.ids[j]!;
    this.keys[j] = k; this.seqs[j] = s; this.ids[j] = d;
  }
}
