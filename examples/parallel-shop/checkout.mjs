import { discountedPrice } from './pricing.mjs';
import { shippingCost } from './shipping.mjs';
export function checkout(cents, discount, method) {
  const subtotal = discountedPrice(cents, discount);
  return { subtotal, shipping: shippingCost(subtotal, method), total: subtotal + shippingCost(subtotal, method) };
}
