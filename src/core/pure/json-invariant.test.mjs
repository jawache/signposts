import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonInvariant } from './json-invariant.mjs';

test('keysPrefixedWith: only //-prefixed keys pass', () => {
  const a = { path: 'scripts', keysPrefixedWith: '//' };
  assert.equal(jsonInvariant('{"scripts":{"//":"see justfile"}}', a).length, 0);
  assert.equal(jsonInvariant('{"scripts":{"//":"x","dev":"run"}}', a).length, 1);
});

test('matches: SemVer regex', () => {
  const a = { path: 'version', matches: '^\\d+\\.\\d+\\.\\d+$' };
  assert.equal(jsonInvariant('{"version":"1.2.3"}', a).length, 0);
  assert.equal(jsonInvariant('{"version":"1.2"}', a).length, 1);
});

test('equals + required as a list', () => {
  const strict = [
    { path: 'compilerOptions.strict', equals: true, required: true },
    { path: 'compilerOptions.noUncheckedIndexedAccess', equals: true },
  ];
  assert.equal(jsonInvariant('{"compilerOptions":{"strict":true}}', strict).length, 0);      // optional absent → fine
  assert.equal(jsonInvariant('{"compilerOptions":{}}', strict).length, 1);                    // required absent → hit
  assert.equal(jsonInvariant('{"compilerOptions":{"strict":false,"noUncheckedIndexedAccess":false}}', strict).length, 2);
});

test('unparseable JSON → no hits (fail-safe)', () => {
  assert.equal(jsonInvariant('{not json', { path: 'x', matches: '.' }).length, 0);
});
