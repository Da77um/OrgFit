// Exact rational arithmetic for bounded decimal configuration. No intermediate
// rounding: coverage and band comparisons operate on the original fractions.
export class ScoreNumber {
  readonly n: bigint;
  readonly d: bigint;
  constructor(n: bigint, d = 1n) {
    if (!d) throw new Error("ZERO_DENOMINATOR");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    let a = n < 0n ? -n : n,
      b = d;
    while (b) [a, b] = [b, a % b];
    this.n = n / a;
    this.d = d / a;
  }
  static from(value: string | number): ScoreNumber {
    const s = String(value);
    if (!/^-?\d{1,12}(?:\.\d{1,6})?$/.test(s))
      throw new Error("INVALID_NUMBER");
    const parts = s.split(".");
    return new ScoreNumber(
      BigInt(parts.join("")),
      10n ** BigInt(parts[1]?.length ?? 0),
    );
  }
  add(v: ScoreNumber) {
    return new ScoreNumber(this.n * v.d + v.n * this.d, this.d * v.d);
  }
  sub(v: ScoreNumber) {
    return new ScoreNumber(this.n * v.d - v.n * this.d, this.d * v.d);
  }
  mul(v: ScoreNumber) {
    return new ScoreNumber(this.n * v.n, this.d * v.d);
  }
  div(v: ScoreNumber) {
    return new ScoreNumber(this.n * v.d, this.d * v.n);
  }
  compare(v: ScoreNumber) {
    const n = this.n * v.d - v.n * this.d;
    return n < 0n ? -1 : n > 0n ? 1 : 0;
  }
  number() {
    // Normalized mixed scales can produce fractions with thousands of digits.
    // Divide before converting; converting both integers first could yield NaN.
    const numerator = Number(this.n),
      denominator = Number(this.d);
    if (Number.isFinite(numerator) && Number.isFinite(denominator))
      return numerator / denominator;
    const ns = (this.n < 0n ? -this.n : this.n).toString(),
      ds = this.d.toString();
    const nh = ns.slice(0, 16),
      dh = ds.slice(0, 16);
    return (
      (this.n < 0n ? -1 : 1) *
      (Number(nh) / Number(dh)) *
      10 ** (ns.length - nh.length - ds.length + dh.length)
    );
  }
  exact() {
    return { numerator: String(this.n), denominator: String(this.d) };
  }
  format(places = 1) {
    if (!Number.isInteger(places) || places < 0 || places > 6)
      throw new Error("INVALID_PRECISION");
    const scale = 10n ** BigInt(places),
      abs = this.n < 0n ? -this.n : this.n;
    const rounded = (abs * scale * 2n + this.d) / (this.d * 2n);
    const s = rounded.toString().padStart(places + 1, "0");
    return (
      (this.n < 0n && rounded ? "-" : "") +
      (places ? s.slice(0, -places) + "." + s.slice(-places) : s)
    );
  }
}
export const N = ScoreNumber.from;
export const total = (values: ScoreNumber[]) =>
  values.reduce((a, b) => a.add(b), N(0));
export const normalize = (
  x: ScoreNumber,
  lower: ScoreNumber,
  upper: ScoreNumber,
  reverse = false,
) => {
  if (upper.compare(lower) <= 0 || x.compare(lower) < 0 || x.compare(upper) > 0)
    throw new Error("INVALID_BOUNDS");
  return (reverse ? lower.add(upper).sub(x) : x)
    .sub(lower)
    .mul(N(100))
    .div(upper.sub(lower));
};
