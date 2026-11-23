import { DISCOUNT_RATE } from "./config.js";
import { applyDiscount } from "./pricing.js";
import { renderReceipt } from "./receipt.js";
import { formatHeader } from "./receipt.js";

export function checkout(cart) {
	const subtotal = cart.reduce((sum, row) => sum + row.price * row.qty, 0);
	const discounted = applyDiscount(subtotal, DISCOUNT_RATE);
	return { ok: true, header: formatHeader("checkout"), receipt: renderReceipt(cart), subtotal, discounted };
}