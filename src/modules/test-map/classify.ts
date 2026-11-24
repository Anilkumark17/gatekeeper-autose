import { posix } from "node:path";

export type TestRole = "test" | "e2e" | "support";

const CODE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);

const SUPPORT_SEGMENTS = new Set(["__mocks__", "__fixtures__", "fixtures", "test-utils"]);
const TEST_SEGMENT = "__tests__";
const BROAD_SUPPORT_SEGMENTS = new Set([
	"test",
	"tests",
	"e2e",
	"playwright",
	"cypress",
	"testing",
]);

const SETUP_BASENAMES = new Set([
	"setupTests",
	"setup-tests",
	"testSetup",
	"test-setup",
	"globalSetup",
	"global-setup",
	"globalTeardown",
	"global-teardown",
]);

const RUNNER_CONFIG = /^(vitest|jest|playwright|cypress)\.(config|setup|workspace)\./i;

function fileExtension(relpath: string): string {
	const base = posix.basename(relpath);
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return "";
	return base.slice(dot);
}

function stem(relpath: string): string {
	const base = posix.basename(relpath);
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return base;
	return base.slice(0, dot);
}

function dirSegments(relpath: string): string[] {
	const dir = posix.dirname(relpath);
	if (dir === "." || dir === "") return [];
	return dir.split("/");
}

function isE2eBasename(relpath: string): boolean {
	const base = posix.basename(relpath);
	return /\.e2e\.[^/]+$/i.test(base) || /\.cy\.[^/]+$/i.test(base);
}

function isUnitTestBasename(relpath: string): boolean {
	const base = posix.basename(relpath);
	return /\.test\.[^/]+$/i.test(base) || /\.spec\.[^/]+$/i.test(base);
}

function isSupportBasename(relpath: string): boolean {
	const base = posix.basename(relpath);
	if (RUNNER_CONFIG.test(base)) return true;
	const name = stem(relpath);
	if (SETUP_BASENAMES.has(name)) return true;
	return false;
}

export function classifyTestFile(relpath: string): TestRole | null {
	if (!CODE_EXTENSIONS.has(fileExtension(relpath))) {
		return null;
	}

	if (isE2eBasename(relpath)) {
		return "e2e";
	}

	if (isUnitTestBasename(relpath)) {
		return "test";
	}

	if (isSupportBasename(relpath)) {
		return "support";
	}

	for (const seg of dirSegments(relpath)) {
		if (SUPPORT_SEGMENTS.has(seg)) {
			return "support";
		}
	}

	for (const seg of dirSegments(relpath)) {
		if (seg === TEST_SEGMENT) {
			return "test";
		}
	}

	for (const seg of dirSegments(relpath)) {
		if (BROAD_SUPPORT_SEGMENTS.has(seg)) {
			return "support";
		}
	}

	return null;
}
