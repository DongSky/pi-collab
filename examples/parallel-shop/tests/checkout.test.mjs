import assert from 'node:assert/strict';
import test from 'node:test';
import { checkout } from '../checkout.mjs';
test('independent implementations compose at the discounted shipping threshold', () => {
  assert.deepEqual(checkout(1000,10,'standard'),{subtotal:900,shipping:500,total:1400});
  assert.deepEqual(checkout(5000,0,'standard'),{subtotal:5000,shipping:0,total:5000});
  assert.deepEqual(checkout(5000,10,'standard'),{subtotal:4500,shipping:500,total:5000});
  assert.deepEqual(checkout(10000,50,'express'),{subtotal:5000,shipping:1200,total:6200});
});
