import { describe, expect, it } from 'vitest';

import { all, err, flatMap, isErr, isOk, map, mapErr, ok, unwrapOr } from './result.js';

describe('Result', () => {
  it('narrows to the success branch', () => {
    const result = ok(42);
    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
    if (isOk(result)) expect(result.value).toBe(42);
  });

  it('narrows to the failure branch', () => {
    const result = err('BOOM');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error).toBe('BOOM');
  });

  it('map transforms successes and leaves failures alone', () => {
    expect(map(ok(2), (n) => n * 2)).toEqual(ok(4));
    expect(map(err<string>('E'), (n: number) => n * 2)).toEqual(err('E'));
  });

  it('flatMap chains fallible steps and short-circuits on the first failure', () => {
    const double = (n: number) => ok(n * 2);
    const fail = () => err('E');

    expect(flatMap(ok(2), double)).toEqual(ok(4));
    expect(flatMap(ok(2), fail)).toEqual(err('E'));
    expect(flatMap(err<string>('FIRST'), double)).toEqual(err('FIRST'));
  });

  it('mapErr transforms failures and leaves successes alone', () => {
    expect(mapErr(err('E'), (e) => `${e}!`)).toEqual(err('E!'));
    expect(mapErr(ok(1), (e: string) => `${e}!`)).toEqual(ok(1));
  });

  it('unwrapOr falls back only on failure', () => {
    expect(unwrapOr(ok(1), 9)).toBe(1);
    expect(unwrapOr(err<string>('E'), 9)).toBe(9);
  });

  it('all collects successes and stops at the first failure', () => {
    expect(all([ok(1), ok(2), ok(3)])).toEqual(ok([1, 2, 3]));
    expect(all([ok(1), err('SECOND'), err('THIRD')])).toEqual(err('SECOND'));
    expect(all([])).toEqual(ok([]));
  });
});
