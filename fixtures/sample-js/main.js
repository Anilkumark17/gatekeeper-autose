import { addToCart } from "./cart.js";
import { flowsIntoPurchase } from "./flows.js";
import { auditStep } from "./audit.js";

const cart = addToCart([], { sku: "tee-1", qty: 1, price: 20, label: "tee" });
auditStep("checkout");
const purchase = flowsIntoPurchase(cart);

export async function loadPromo() {
	const module = await import("./pricing.js");
	return module.totalWithTax(10);
}

export { cart, purchase };