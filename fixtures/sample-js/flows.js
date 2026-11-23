import { checkout } from "./checkout.js";

export function flowsIntoPurchase(cart) {
	return checkout(cart);
}