/**
 * In-process test double for the @upstash/redis calls RedisStore and RedisDailyCounter make (lib/store.ts RedisLike):
 * GET, SET (NX), EVAL of the one compare-and-set script, ZADD / ZREM / ZRANGE REV, INCR, EXPIRE, PING, and MULTI /
 * pipeline batches. Values are strings, as with `automaticDeserialization: false`. No network.
 */
import { CAS_SCRIPT, type RedisBatch, type RedisLike } from "../lib/store";

export class FakeRedis implements RedisLike {
  readonly strings = new Map<string, string>();
  readonly zsets = new Map<string, Map<string, number>>();
  readonly ttl = new Map<string, number>();
  /** every command, in order (tests count them) */
  readonly log: string[] = [];
  /** when set, every command throws it (an outage: Upstash over quota, network down) */
  fail: Error | null = null;
  /** runs between a claim's read and its write (tests interleave a concurrent claim here) */
  beforeWrite: (() => Promise<void>) | null = null;

  private cmd(name: string) {
    this.log.push(name);
    if (this.fail) throw this.fail;
  }
  private async race() {
    const f = this.beforeWrite;
    this.beforeWrite = null;
    if (f) await f();
  }

  async get<T = string>(key: string): Promise<T | null> {
    this.cmd("GET");
    return (this.strings.get(key) ?? null) as T | null;
  }
  async set(key: string, value: string, opts?: { nx: true }): Promise<unknown> {
    if (opts?.nx) await this.race();
    this.cmd(opts?.nx ? "SET NX" : "SET");
    if (opts?.nx && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return "OK";
  }
  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    await this.race();
    this.cmd("EVAL");
    if (script !== CAS_SCRIPT) throw new Error("FakeRedis: unknown script");
    if (this.strings.get(keys[0]!) !== args[0]) return 0;
    this.strings.set(keys[0]!, args[1]!);
    return 1;
  }
  async zrange(key: string, start: number, stop: number, opts: { rev: true }): Promise<unknown[]> {
    this.cmd("ZRANGE");
    const z = [...(this.zsets.get(key) ?? new Map<string, number>()).entries()];
    // Redis orders equal scores lexicographically by member; REV reverses the whole order
    z.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (opts.rev) z.reverse();
    return z.slice(start, stop < 0 ? undefined : stop + 1).map(([m]) => m);
  }
  async ping(): Promise<string> {
    this.cmd("PING");
    return "PONG";
  }
  private zadd(key: string, sm: { score: number; member: string }) {
    const z = this.zsets.get(key) ?? new Map<string, number>();
    z.set(sm.member, sm.score);
    this.zsets.set(key, z);
    return 1;
  }
  private zrem(key: string, member: string) {
    return this.zsets.get(key)?.delete(member) ? 1 : 0;
  }
  private incr(key: string) {
    const n = Number(this.strings.get(key) ?? "0") + 1;
    this.strings.set(key, String(n));
    return n;
  }
  private batch(name: string): RedisBatch {
    const ops: { name: string; run: () => unknown }[] = [];
    const b: RedisBatch = {
      set: (k, v) => (ops.push({ name: "SET", run: () => (this.strings.set(k, v), "OK") }), b),
      zadd: (k, sm) => (ops.push({ name: "ZADD", run: () => this.zadd(k, sm) }), b),
      zrem: (k, m) => (ops.push({ name: "ZREM", run: () => this.zrem(k, m) }), b),
      incr: (k) => (ops.push({ name: "INCR", run: () => this.incr(k) }), b),
      expire: (k, s) => (ops.push({ name: "EXPIRE", run: () => (this.ttl.set(k, s), 1) }), b),
      exec: async <T extends unknown[] = unknown[]>() => {
        this.cmd(`${name}[${ops.map((o) => o.name).join(",")}]`);
        return ops.map((o) => o.run()) as T;
      },
    };
    return b;
  }
  multi(): RedisBatch {
    return this.batch("MULTI");
  }
  pipeline(): RedisBatch {
    return this.batch("PIPELINE");
  }
}
