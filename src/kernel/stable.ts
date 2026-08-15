import { createHash } from "node:crypto";

import type { Hash, RecordedRandomDraw, StableRandomKey } from "./types.ts";

type CanonicalObject = Record<string, unknown>;

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Stable serialization does not accept non-finite numbers");
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`Stable serialization does not accept ${typeof value}`);
  }

  const objectValue = value as object;
  if (ancestors.has(objectValue)) {
    throw new TypeError("Stable serialization does not accept cyclic values");
  }
  ancestors.add(objectValue);

  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("Stable serialization does not accept sparse arrays");
        }
      }
      return `[${value.map((item) => canonicalize(item, ancestors)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Stable serialization accepts only JSON objects and arrays");
    }

    const symbolKeys = Object.getOwnPropertySymbols(value);
    if (symbolKeys.length > 0) {
      throw new TypeError("Stable serialization does not accept symbol keys");
    }

    const record = value as CanonicalObject;
    const fields = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], ancestors)}`);
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(objectValue);
  }
}

/** Serialize strict JSON data with recursively sorted object keys. */
export function stableStringify(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

/** Hash a value's canonical representation with SHA-256. */
export function hash(value: unknown): Hash {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/**
 * Return a deterministic value in [0, 1).
 *
 * StableRandomKey intentionally has no run or branch id. Anchored histories
 * with the same seed and unchanged semantic causal instance therefore share a
 * draw, while changed causal descendants receive a different instance key.
 */
export function stableRandom(key: StableRandomKey): RecordedRandomDraw {
  if (!Number.isSafeInteger(key.drawIndex) || key.drawIndex < 0) {
    throw new RangeError("Stable random drawIndex must be a non-negative safe integer");
  }

  const keyHash = hash(key);
  const first52Bits = BigInt(`0x${keyHash.slice(0, 13)}`);
  const unitInterval = Number(first52Bits) / 2 ** 52;
  return { key, keyHash, unitInterval };
}

/** Deterministically choose an integer in [0, upperExclusive). */
export function stableRandomInt(key: StableRandomKey, upperExclusive: number): number {
  if (!Number.isSafeInteger(upperExclusive) || upperExclusive <= 0) {
    throw new RangeError("upperExclusive must be a positive safe integer");
  }
  return Math.floor(stableRandom(key).unitInterval * upperExclusive);
}
