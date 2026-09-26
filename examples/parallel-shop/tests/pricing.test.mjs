import assert from 'node:assert/strict';
import test from 'node:test';
import { discountedPrice } from '../pricing.mjs';
test('discounts use integer cents with half-up rounding', () => {
  for (const [cents, percent, expected] of [[1000,10,900],[101,50,51],[0,0,0],[99,100,0],[1234,0,1234],[100,12.5,88]])
    assert.equal(discountedPrice(cents,percent),expected);
});
test('invalid amounts and percentages fail explicitly', () => {
  for(const cents of [-1,0.5,NaN,Infinity,'100',Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>discountedPrice(cents,10));
  for(const percent of [-1,101,NaN,Infinity,'10']) assert.throws(()=>discountedPrice(100,percent));
});
