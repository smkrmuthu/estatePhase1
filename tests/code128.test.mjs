import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// code128.js is a plain browser script; run it as one.
const Code128 = vm.runInNewContext(readFileSync(new URL('../public/js/code128.js', import.meta.url), 'utf8') + '\n;Code128');

test('Code 128 output has start, checksum and stop', () => {
  const bits = Code128.modules('PKG-0123456789A');
  // Start B + 15 data symbols + checksum = 17 symbols x 11 modules, then a 13-module stop.
  assert.equal(bits.length, 17 * 11 + 13);
  assert.ok(bits.startsWith('11010010000'));
  assert.ok(bits.endsWith('1100011101011'));
  assert.throws(() => Code128.modules('é'), /cannot be encoded/);
});

test('Code 128 matches the reference encoding', () => {
  // Verified against python-barcode and decoded with zxing during development.
  assert.equal(Code128.modules('PKG-D6E66YT2W18'),
    '11010010000111011101101011000111011010001000100110111001011000100011001110100100011010001100111010011001110100111011010001101110001011001110010111010001101001110011011101001100100110010001100011101011');
});
