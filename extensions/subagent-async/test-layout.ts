#!/usr/bin/env -S npx tsx
/**
 * Tests for Layout — pure-function unit tests for the grid-computing Layout class.
 * Run: npx tsx test-layout.ts
 */

import assert from "node:assert";
import { Layout, SEP } from "./watch-session-v2.js";

// ── Test harness ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
	try {
		fn();
		console.log(`  ✅ ${name}`);
		passed++;
	} catch (e) {
		console.log(`  ❌ ${name}`);
		console.log(`     ${(e as Error).message}`);
		failed++;
	}
}

function eq<T>(actual: T, expected: T, msg?: string): void {
	assert.deepStrictEqual(actual, expected, msg);
}

// ── Helper to build and configure a Layout ──────────────────────────────────

function makeLayout(N: number, cols: number, rows: number): Layout {
	const l = new Layout();
	l.resize(cols, rows);
	l.paneCount = N;
	return l;
}

// ── Behavior matrix ─────────────────────────────────────────────────────────

console.log("\nLayout — single pane:");
test("single pane, 200×50 → 1×1", () => {
	const l = makeLayout(1, 200, 50);
	eq(l.gridRows, 1);
	eq(l.gridCols, 1);
	eq(l.paneCells.length, 1);
	eq(l.paneCells[0].length, 1);
	eq(l.paneCells[0][0], { row: 0, col: 0 });
	// paneHeight = n*cellH + max(0, n-1) = cellH (for 1 cell)
	// cellH = floor((50 - 1 - 0)/1) = 49
	eq(l.paneHeight(0), l.cellH);
	eq(l.paneBodyHeight(0), l.cellH - 1);
});

console.log("\nLayout — two panes:");
test("two panes, wide term 200×50 → 1×2", () => {
	const l = makeLayout(2, 200, 50);
	eq(l.gridRows, 1);
	eq(l.gridCols, 2);
	// Each ~99 wide: floor((200-1)/2) = 99
	eq(l.cellW, 99);
	eq(l.paneCells.length, 2);
	eq(l.paneCells[0][0], { row: 0, col: 0 });
	eq(l.paneCells[1][0], { row: 0, col: 1 });
	// No merged cells
	eq(l.cellsInPane(0), 1);
	eq(l.cellsInPane(1), 1);
});

test("two panes, narrow term 80×24 → 2×1", () => {
	const l = makeLayout(2, 80, 24);
	eq(l.gridRows, 2);
	eq(l.gridCols, 1);
	// 1×2 would be cellW = floor((80-1)/2) = 39 < 40 MIN_CELL_W → rejected
});

console.log("\nLayout — three panes:");
test("three panes, wide 200×50 → 2×2 with merge", () => {
	const l = makeLayout(3, 200, 50);
	eq(l.gridRows, 2);
	eq(l.gridCols, 2);
	eq(l.paneCells.length, 3);
	// pane 0: {0,0}, pane 1: {0,1}, pane 2: {1,0}
	// empty cell {1,1} merges into pane 1 (above) → pane 1 gets {0,1}+{1,1}
	eq(l.paneCells[0][0], { row: 0, col: 0 });
	eq(l.cellsInPane(0), 1);
	eq(l.paneCells[1][0], { row: 0, col: 1 });
	eq(l.paneCells[1][1], { row: 1, col: 1 });
	eq(l.cellsInPane(1), 2);
	eq(l.paneCells[2][0], { row: 1, col: 0 });
	eq(l.cellsInPane(2), 1);
	// Merged pane height = 2*cellH + 1 (for the internal gap)
	eq(l.paneHeight(1), 2 * l.cellH + 1);
	eq(l.paneBodyHeight(1), l.paneHeight(1) - 1);
});

test("three panes, ultra-wide 300×60 → 1×3", () => {
	const l = makeLayout(3, 300, 60);
	eq(l.gridRows, 1);
	eq(l.gridCols, 3);
	eq(l.paneCells.length, 3);
	eq(l.cellsInPane(0), 1);
	eq(l.cellsInPane(1), 1);
	eq(l.cellsInPane(2), 1);
});

console.log("\nLayout — four panes:");
test("four panes, 200×50 → 2×2 (no empty cells)", () => {
	const l = makeLayout(4, 200, 50);
	eq(l.gridRows, 2);
	eq(l.gridCols, 2);
	eq(l.paneCells.length, 4);
	// All unmerged
	for (let i = 0; i < 4; i++) {
		eq(l.cellsInPane(i), 1);
	}
});

console.log("\nLayout — five panes (odd merge):");
test("five panes, 200×50 → 3×2 with merge", () => {
	// Scoring: 3×2 (cellW=99, cellH=15) beats 2×3 (cellW=66<80, big wp penalty)
	const l = makeLayout(5, 200, 50);
	eq(l.gridRows, 3);
	eq(l.gridCols, 2);
	// 6 cells, 5 panes, 1 empty at {2,1}
	// Reading-order fill: pane0={0,0}, pane1={0,1}, pane2={1,0}, pane3={1,1}, pane4={2,0}, empty={2,1}
	// Empty {2,1}: below=out, above={1,1}=pane3 → merges into pane3
	eq(l.paneCells[3].length, 2); // merged (pane at index 3)
	eq(l.paneCells[3][0], { row: 1, col: 1 });
	eq(l.paneCells[3][1], { row: 2, col: 1 });
	eq(l.paneHeight(3), 2 * l.cellH + 1);
});

console.log("\nLayout — six panes:");
test("six panes, 200×50 → 3×2 (no empty cells)", () => {
	const l = makeLayout(6, 200, 50);
	eq(l.gridRows, 3);
	eq(l.gridCols, 2);
	eq(l.paneCells.length, 6);
	for (let i = 0; i < 6; i++) {
		eq(l.cellsInPane(i), 1);
	}
});

console.log("\nLayout — seven panes (two merges):");
test("seven panes, 200×40 → 4×2, one empty cell merges up", () => {
	// Scoring: 4×2 (cellW=99, cellH=9) beats 3×3 (cellW=66<80, big wp penalty)
	const l = makeLayout(7, 200, 40);
	eq(l.gridRows, 4);
	eq(l.gridCols, 2);
	// 8 cells, 7 panes, 1 empty at {3,1}
	// Reading-order: pane0={0,0}, pane1={0,1}, pane2={1,0}, pane3={1,1}, pane4={2,0}, pane5={2,1}, pane6={3,0}, empty={3,1}
	// Empty {3,1}: below=out, above={2,1}=pane5 → merges into pane5
	eq(l.cellsInPane(5), 2);
	// All other panes have 1 cell
	for (let i = 0; i < 7; i++) {
		if (i !== 5) eq(l.cellsInPane(i), 1);
	}
});

console.log("\nLayout — boundary width:");
test("two panes, 160×40 → 1×2 (79 < W_MIN but still chosen over 2×1)", () => {
	const l = makeLayout(2, 160, 40);
	eq(l.gridRows, 1);
	eq(l.gridCols, 2);
	// cellW = floor((160-1)/2) = 79, just under W_MIN=80
	eq(l.cellW, 79);
});

console.log("\nLayout — tiny terminal:");
test("three panes, 60×12 → fallback (sub-min cells, no crash)", () => {
	const l = makeLayout(3, 60, 12);
	// Should not crash; uses 1×3 fallback
	eq(l.gridRows, 1);
	eq(l.gridCols, 3);
	eq(l.paneCells.length, 3);
});

console.log("\nLayout — merge invariant:");
test("all pane cells share one column (5 panes, 200×50 → 3×2)", () => {
	const l = makeLayout(5, 200, 50);
	for (let i = 0; i < l.paneCells.length; i++) {
		const cells = l.paneCells[i];
		const col0 = cells[0].col;
		for (const c of cells) {
			eq(c.col, col0, `pane ${i} cell at row ${c.row} col ${c.col} has wrong column`);
		}
	}
});

test("all pane cells share one column (7 panes, 200×40 → 4×2)", () => {
	const l = makeLayout(7, 200, 40);
	for (let i = 0; i < l.paneCells.length; i++) {
		const cells = l.paneCells[i];
		assert(cells.length > 0, `pane ${i} has no cells`);
		const col0 = cells[0].col;
		for (const c of cells) {
			eq(c.col, col0, `pane ${i} cell at row ${c.row} col ${c.col} has wrong column`);
		}
	}
});

console.log("\nLayout — panesByColumn:");
test("panesByColumn groups correctly (4 panes, 2×2)", () => {
	const l = makeLayout(4, 200, 50);
	const byCol = l.panesByColumn();
	eq(byCol.length, 2);
	eq(byCol[0], [0, 2]); // column 0: panes at rows 0,1
	eq(byCol[1], [1, 3]); // column 1: panes at rows 0,1
});

test("panesByColumn with merge (3 panes, 2×2)", () => {
	const l = makeLayout(3, 200, 50);
	const byCol = l.panesByColumn();
	eq(byCol.length, 2);
	// column 0: pane 0 (row 0), pane 2 (row 1)
	eq(byCol[0], [0, 2]);
	// column 1: pane 1 (row 0, also owns row 1 via merge)
	eq(byCol[1], [1]);
});

console.log("\nLayout — paneAt hit-test:");
test("paneAt: 3 panes @ 200×50 (2×2), click in cell (0,0) → pane0", () => {
	const l = makeLayout(3, 200, 50);
	// Column 0 starts at col 0, width = cellW=99
	const midCol = Math.floor(l.cellW / 2);
	const midRow = 1; // middle of header row
	eq(l.paneAt(midRow, midCol), 0);
});

test("paneAt: click in column 1 row 0 → pane1", () => {
	const l = makeLayout(3, 200, 50);
	// Column 1 starts at cellW + SEP = 99 + 1 = 100
	const col = l.cellW + SEP + 5;
	const row = 1;
	eq(l.paneAt(row, col), 1);
});

test("paneAt: click in column 0 row (header of pane2) → pane2", () => {
	const l = makeLayout(3, 200, 50);
	// pane 2 starts at row: paneHeight(0) + SEP
	const row = l.paneHeight(0) + SEP + 1; // header row of pane2
	const col = 5;
	eq(l.paneAt(row, col), 2);
});

test("paneAt: click on merged pane's extra cell (column 1, row in merged region)", () => {
	const l = makeLayout(3, 200, 50);
	// pane 1 has cells {0,1} and {1,1} → merged height = 2*cellH+1, fills entire column
	// pane 0 occupies rows 0..paneHeight(0)-1, separator at paneHeight(0)
	// pane 1 occupies full gridHeight (merges fill whole column height)
	// Click just below the separator row, inside column 1's merged region
	const rowInMerge = l.paneHeight(0) + SEP + 2; // just below separator
	const col = l.cellW + SEP + 5; // column 1
	eq(l.paneAt(rowInMerge, col), 1);
});

test("paneAt: gap / separator row → -1", () => {
	const l = makeLayout(3, 200, 50);
	// The separator row is at paneHeight(0)
	const sepRow = l.paneHeight(0); // the row right after pane0, which is the separator
	const midCol = Math.floor(l.cellW / 2);
	eq(l.paneAt(sepRow, midCol), -1);
});

test("paneAt: out of range column → -1", () => {
	const l = makeLayout(3, 200, 50);
	eq(l.paneAt(0, 9999), -1);
});

console.log("\nLayout — resize changes grid:");
test("resize from 80×50 to 200×50 changes 3 panes from 2×1 to 2×2", () => {
	const l = new Layout();
	l.paneCount = 3;
	l.resize(80, 50);
	// At 80×50: 1×3: cellW=floor((80-2)/3)=26<40 rejected
	// 2×2: cellW=floor((80-1)/2)=39<40 rejected
	// 3×1: cellW=80, cellH=floor((50-1-2)/3)=15 → valid
	eq(l.gridRows, 3);
	eq(l.gridCols, 1);

	l.resize(200, 50);
	// At 200×50: 2×2 beats 3×1
	eq(l.gridRows, 2);
	eq(l.gridCols, 2);
});

console.log("\nLayout — paneWidth:");
test("paneWidth: last column gets remainder", () => {
	const l = makeLayout(3, 200, 50); // 2×2, cellW=99, lastColRemainder=200-2*99-1=1
	// Column 0: cellW = 99
	eq(l.paneWidth(0), 99);
	// Column 1: cellW + remainder = 99 + 1 = 100
	eq(l.paneWidth(1), 100);
});

test("paneWidth: all panes in same column have same width", () => {
	const l = makeLayout(3, 200, 50);
	// Same col index → same width
	eq(l.paneColumn(0), l.paneColumn(2)); // both col 0
	eq(l.paneWidth(0), l.paneWidth(2));
});

console.log("\nLayout — gridHeight:");
test("gridHeight matches column render height (4 panes, 2×2)", () => {
	const l = makeLayout(4, 200, 50); // 2×2
	// gridHeight = 2*cellH + 1
	const expected = 2 * l.cellH + 1;
	eq(l.gridHeight(), expected);
	// This should equal sum of paneHeights + separators in each column
	const byCol = l.panesByColumn();
	for (const col of byCol) {
		let sum = 0;
		for (let k = 0; k < col.length; k++) {
			sum += l.paneHeight(col[k]);
			if (k < col.length - 1) sum += SEP;
		}
		eq(sum, l.gridHeight(), `column ${col} height mismatch`);
	}
});

test("gridHeight with merged pane (3 panes, 2×2)", () => {
	const l = makeLayout(3, 200, 50); // 2×2, pane1 merged
	const byCol = l.panesByColumn();
	// Column 0: pane0 + pane2 + separator
	let sum0 = 0;
	const col0 = byCol[0];
	for (let k = 0; k < col0.length; k++) {
		sum0 += l.paneHeight(col0[k]);
		if (k < col0.length - 1) sum0 += SEP;
	}
	eq(sum0, l.gridHeight());
	// Column 1: pane1 only (merged, fills full height)
	const col1 = byCol[1];
	eq(col1.length, 1);
	eq(l.paneHeight(col1[0]), l.gridHeight());
});

console.log("\nLayout — zero panes:");
test("zero panes → gridRows=0, no crash", () => {
	const l = makeLayout(0, 200, 50);
	eq(l.gridRows, 0);
	eq(l.gridCols, 0);
	eq(l.paneCells.length, 0);
	eq(l.panesByColumn().length, 0);
	eq(l.gridHeight(), 0);
});

// ── Summary ─────────────────────────────────────────────────────────────────

process.on("exit", () => {
	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) process.exitCode = 1;
});
