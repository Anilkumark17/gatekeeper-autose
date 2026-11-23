import { stockFor } from "./inventory.js";
import { totalWithTax } from "./pricing.js";

export function addToCart(cart, item) {
	if (stockFor(item.sku) < item.qty) {
		throw new Error("out of stock");
	}
	cart.push(item);
	return cart;
}

export function cartTotal(cart) {
	const subtotal = cart.reduce((sum, row) => sum + row.price * row.qty, 0);
	return totalWithTax(subtotal);
}