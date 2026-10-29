import { makeZip } from './zip-writer.ts';

/**
 * Writes the smallest XLSX the workbook reader takes, for tests that need a progress sheet of their own: each cell is a number, an inline
 * text, or a formula without a computed value (`{ f: 'CONCATENATE(…)' }`, as Feishu's export writes them). Row 1 is the header.
 */
export type XlsxCell = string | number | null | { f: string };
export interface XlsxSheet { name: string; rows: XlsxCell[][] }

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const letter = (index: number) => { let s = ''; for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

function cellXml(value: XlsxCell, coord: string): string {
  if (value === null) return '';
  if (typeof value === 'number') return `<c r="${coord}"><v>${value}</v></c>`;
  if (typeof value === 'string') return `<c r="${coord}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`;
  return `<c r="${coord}"><f>${escape(value.f)}</f></c>`;
}

export function makeXlsx(sheets: XlsxSheet[]): Buffer {
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const workbook = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${ns}" xmlns:r="${rel}"><sheets>${
    sheets.map((s, i) => `<sheet name="${escape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`;
  const sheetXml = (sheet: XlsxSheet) => `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${ns}"><sheetData>${
    sheet.rows.map((cells, r) => `<row r="${r + 1}">${cells.map((v, c) => cellXml(v, `${letter(c + 1)}${r + 1}`)).join('')}</row>`).join('')}</sheetData></worksheet>`;
  return makeZip([
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ]);
}
