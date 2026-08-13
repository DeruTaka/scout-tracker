// Write the local .xlsx mirror (always available, no credentials needed).
import ExcelJS from 'exceljs';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Datastore } from '../store/datastore.js';
import { buildSheets } from './rows.js';

export async function writeXlsx(store: Datastore, path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ps-team-scouter';
  for (const sheet of buildSheets(store)) {
    const ws = wb.addWorksheet(sheet.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.addRow(sheet.header);
    ws.getRow(1).font = { bold: true };
    for (const row of sheet.rows) ws.addRow(row);
    // reasonable column widths; wrap the big text columns
    ws.columns.forEach((col) => {
      const header = String(col.values?.[1] ?? '');
      if (header === 'Importable' || header === 'Team Paste' || header === 'Notes') {
        col.width = 40;
        col.alignment = { wrapText: true, vertical: 'top' };
      } else {
        col.width = Math.min(Math.max(header.length + 2, 10), 24);
      }
    });
  }
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await wb.xlsx.writeFile(path);
}
