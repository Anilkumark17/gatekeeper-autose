import type pg from "pg";
import { from as copyFrom } from "pg-copy-streams";

const BATCH = 10_000;

function csvCell(value: string | number | boolean | null | undefined): string {
	if (value === null || value === undefined) return "\\N";
	const s = String(value);
	if (/[",\n\r\\]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
	if (s === "\\N") return `"\\N"`;
	return s;
}

function formatCsvRow(cells: (string | number | boolean | null | undefined)[]): string {
	return `${cells.map(csvCell).join(",")}\n`;
}

async function copyCsvBatches(
	client: pg.PoolClient,
	copySql: string,
	rows: (string | number | boolean | null)[][],
): Promise<number> {
	if (rows.length === 0) return 0;
	let copied = 0;
	for (let i = 0; i < rows.length; i += BATCH) {
		const slice = rows.slice(i, i + BATCH);
		const body = slice.map((row) => formatCsvRow(row).trimEnd()).join("\n") + "\n";
		await new Promise<void>((resolve, reject) => {
			const stream = client.query(copyFrom(copySql));
			stream.on("error", reject);
			stream.on("finish", () => resolve());
			stream.write(body);
			stream.end();
		});
		copied += slice.length;
	}
	return copied;
}

export async function copyStageNodes(
	client: pg.PoolClient,
	rows: (string | number | boolean | null)[][],
): Promise<number> {
	return copyCsvBatches(
		client,
		`COPY stage_nodes (repo_id, id, kind, name, path, line_start, line_end, exported, body_hash, export_hash, last_change_sha, last_change_at, in_degree) FROM STDIN WITH (FORMAT csv, NULL '\\N')`,
		rows,
	);
}

export async function copyStageEdges(
	client: pg.PoolClient,
	rows: (string | number | null)[][],
): Promise<number> {
	return copyCsvBatches(
		client,
		`COPY stage_edges (repo_id, src, dst, type, path, line, meta) FROM STDIN WITH (FORMAT csv, NULL '\\N')`,
		rows,
	);
}

export async function copyStageSearch(client: pg.PoolClient, rows: string[][]): Promise<number> {
	return copyCsvBatches(
		client,
		`COPY stage_search (repo_id, node_id, name_tokens, path_tokens) FROM STDIN WITH (FORMAT csv, NULL '\\N')`,
		rows,
	);
}

export async function copyStageFileRecency(
	client: pg.PoolClient,
	rows: (string | number | boolean)[][],
): Promise<number> {
	return copyCsvBatches(
		client,
		`COPY stage_file_recency (repo_id, path, last_sha, last_at, at_boundary) FROM STDIN WITH (FORMAT csv, NULL '\\N')`,
		rows,
	);
}
