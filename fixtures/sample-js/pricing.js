import { taxRate } from "./config.js";

export function totalWithTax(subtotal) {
	return subtotal + subtotal * taxRate;
}

export function applyDiscount(subtotal, rate) {
	return subtotal * (1 - rate);
}