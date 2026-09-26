import assert from 'node:assert/strict';
import test from 'node:test';
import { shippingCost } from '../shipping.mjs';
test('shipping threshold and express pricing', () => {
  for(const [subtotal,method,expected] of [[0,'standard',500],[4999,'standard',500],[5000,'standard',0],[5001,'standard',0],[100,'express',1200],[5000,'express',1200]])
    assert.equal(shippingCost(subtotal,method),expected);
});
test('invalid input fails explicitly', () => {
  for(const subtotal of [-1,0.5,NaN,Infinity,'100',Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>shippingCost(subtotal,'standard'));
  for(const method of ['overnight','',null,undefined,1]) assert.throws(()=>shippingCost(100,method));
});
