import { describe, expect, it } from "vitest";
import { classifyTestFile } from "./classify.js";

describe("classifyTestFile", () => {
	it.each([
		["src/lib/date.test.ts", "test"],
		["src/lib/date.spec.tsx", "test"],
		["packages/x/__tests__/util.ts", "test"],
		["packages/x/__tests__/fixtures/user.ts", "support"],
		["apps/web/playwright/booking.e2e.ts", "e2e"],
		["cypress/e2e/login.cy.ts", "e2e"],
		["packages/x/__mocks__/fs.ts", "support"],
		["apps/web/playwright/fixtures/users.ts", "support"],
		["test/helpers/db.ts", "support"],
		["vitest.config.mts", "support"],
		["playwright.config.ts", "support"],
		["setupTests.ts", "support"],
		["src/lib/date.ts", null],
		["src/testimonials/card.tsx", null],
		["src/contest/spec-sheet.ts", null],
		["docs/README.test.md", null],
	] as const)("classifies %s as %s", (relpath, expected) => {
		expect(classifyTestFile(relpath)).toBe(expected);
	});
});
