export function stockFor(sku) {
	return sku.endsWith("-x") ? 0 : 12;
}