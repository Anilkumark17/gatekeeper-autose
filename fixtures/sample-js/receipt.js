import { storeName } from "./config.js";
import { joinLines, titleCase } from "./utils/index.js";
import { cartTotal } from "./cart.js";

export function lineFor(item) {
	return titleCase(item.label);
}

export function formatHeader(text) {
	return titleCase(text);
}

export function receiptLines(items) {
	return items.map(lineFor);
}

export function renderReceipt(cart) {
	const itemLines = receiptLines(cart);
	const lines = [formatHeader(storeName), titleCase("thanks for shopping"), ...itemLines, `total=${cartTotal(cart)}`];
	return joinLines(lines);
}