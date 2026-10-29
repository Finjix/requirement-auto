import { need } from './util.ts';

export function columnLetter(index: number): string {
  need(Number.isInteger(index) && index >= 1 && index <= 16384, '列号超出范围');
  let n = index;
  let out = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    out = String.fromCharCode(65 + rest) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function columnIndex(letters: string): number {
  need(/^[A-Za-z]{1,3}$/.test(letters), `不是列名：${letters}`);
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  need(n >= 1 && n <= 16384, `列超出范围：${letters}`);
  return n;
}

export function parseCoord(coord: string): { col: number; row: number } {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(coord);
  need(m, `不是单元格坐标：${coord}`);
  const row = Number(m[2]);
  need(row >= 1 && row <= 1048576, `行超出范围：${coord}`);
  return { col: columnIndex(m[1]!), row };
}

export function coordOf(col: number, row: number): string {
  return `${columnLetter(col)}${row}`;
}

/** A rectangle of cells, written "A1:B2" or "A1" like in the workbook files. */
export class CellRange {
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;

  constructor(spec: string | { minCol: number; maxCol: number; minRow: number; maxRow: number }) {
    if (typeof spec === 'string') {
      const [first, second, ...more] = spec.split(':');
      need(first !== undefined && more.length === 0, `不是单元格范围：${spec}`);
      const a = parseCoord(first);
      const b = second === undefined ? a : parseCoord(second);
      this.minCol = Math.min(a.col, b.col);
      this.maxCol = Math.max(a.col, b.col);
      this.minRow = Math.min(a.row, b.row);
      this.maxRow = Math.max(a.row, b.row);
    } else {
      this.minCol = spec.minCol;
      this.maxCol = spec.maxCol;
      this.minRow = spec.minRow;
      this.maxRow = spec.maxRow;
    }
  }

  contains(coord: string): boolean {
    const { col, row } = parseCoord(coord);
    return col >= this.minCol && col <= this.maxCol && row >= this.minRow && row <= this.maxRow;
  }

  toString(): string {
    const a = coordOf(this.minCol, this.minRow);
    return this.minCol === this.maxCol && this.minRow === this.maxRow ? a : `${a}:${coordOf(this.maxCol, this.maxRow)}`;
  }
}

const CELL_REF = /(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/y;

/**
 * Moves the relative references of a formula as if it had been copied from one cell to another, which is what filling a
 * formula down does. Strings, quoted sheet names and function names are left alone.
 */
export function translateFormula(formula: string, origin: string, dest: string): string {
  const from = parseCoord(origin);
  const to = parseCoord(dest);
  const dRow = to.row - from.row;
  const dCol = to.col - from.col;
  let out = '';
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i]!;
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < formula.length) {
        if (formula[j] === ch) {
          if (formula[j + 1] === ch) { j += 2; continue; }
          break;
        }
        j++;
      }
      out += formula.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const before = out[out.length - 1] ?? '';
    if (/[A-Za-z$]/.test(ch) && !/[A-Za-z0-9_.]/.test(before)) {
      CELL_REF.lastIndex = i;
      const m = CELL_REF.exec(formula);
      const next = m ? formula[i + m[0].length] ?? '' : '';
      if (m && !/[A-Za-z0-9_(.]/.test(next)) {
        const [whole, absCol, letters, absRow, digits] = m;
        const col = absCol ? columnIndex(letters!) : columnIndex(letters!) + dCol;
        const row = absRow ? Number(digits) : Number(digits) + dRow;
        need(col >= 1 && col <= 16384 && row >= 1 && row <= 1048576, '公式平移后引用越界');
        out += `${absCol}${columnLetter(col)}${absRow}${row}`;
        i += whole!.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}
