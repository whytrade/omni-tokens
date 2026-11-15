export const BPS = 10_000n;
/** USD amounts are integers of micro-dollars (10^-6 USD). */
export const MICRO = 1_000_000n;
/** Token prices are USD per whole token, scaled by 10^18 so tiny prices stay exact. */
export const E18 = 10n ** 18n;

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("denominator must be positive");
  if (numerator < 0n) throw new Error("numerator must not be negative");
  return (numerator + denominator - 1n) / denominator;
}

export const minBigInt = (a: bigint, b: bigint) => (a < b ? a : b);
export const maxBigInt = (a: bigint, b: bigint) => (a > b ? a : b);

/**
 * Parses a decimal string into an integer with `scale` fractional digits,
 * rounding any extra digits up. "0.0000015" at scale 6 is 2n.
 */
export function parseDecimal(value: string, scale: number, name: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`${name} must be a non-negative decimal`);
  const fraction = match[2] ?? "";
  const kept = fraction.slice(0, scale).padEnd(scale, "0");
  const scaled = BigInt(match[1]) * 10n ** BigInt(scale) + BigInt(kept || "0");
  return /[1-9]/.test(fraction.slice(scale)) ? scaled + 1n : scaled;
}

/** Formats an integer with `scale` fractional digits, without trailing zeros. */
export function formatDecimal(value: bigint, scale: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(scale);
  const fraction = (abs % base).toString().padStart(scale, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${abs / base}${fraction ? `.${fraction}` : ""}`;
}

/** A USD amount from a provider's floating-point dollars, rounded up to the micro-dollar. */
export function usdToMicros(value: unknown, name: string): bigint {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return parseDecimal(value.toFixed(12), 6, name);
}

/**
 * Multiplies an exact integer by a finite positive float, keeping the float's
 * 16 significant digits: `scaleByFloat(10n ** 18n, 1.5e-9)` is 1500000000n.
 */
export function scaleByFloat(value: bigint, factor: number): bigint {
  if (!Number.isFinite(factor) || factor <= 0) throw new Error("factor must be a finite positive number");
  const [mantissa, exponent] = factor.toExponential(15).split("e");
  const digits = BigInt(mantissa.replace(".", ""));
  const power = Number(exponent) - 15;
  return power >= 0 ? value * digits * 10n ** BigInt(power) : (value * digits) / 10n ** BigInt(-power);
}
