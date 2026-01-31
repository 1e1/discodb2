/**
 * Export via Blob download (DESIGN §6: "no File System Access API ⇒ export via
 * Blob download"). Works on Firefox + Chromium + iOS Safari without WebUSB/FS
 * APIs.
 */

import type { Project } from '../protocol/datamodel';
import { exportDbc } from '../dbc/dbc';

/** Trigger a browser download of `content` as `filename`. */
export function downloadBlob(content: BlobPart, filename: string, mime: string): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has been dispatched.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

/** Export the §3.5 Project as JSON. */
export function exportProjectJson(project: Project): void {
  const json = JSON.stringify(project, null, 2);
  downloadBlob(json, `${safe(project.name)}-${stamp()}.json`, 'application/json');
}

/** Export the §3.5 Project as DBC text (stub writer, see dbc/dbc.ts). */
export function exportProjectDbc(project: Project): void {
  const dbc = exportDbc(project);
  downloadBlob(dbc, `${safe(project.name)}-${stamp()}.dbc`, 'text/plain');
}

/**
 * Export a captured frame table snapshot as CSV (id, name, dlc, hex, rate, ...).
 * Rows are pre-formatted by the caller to avoid coupling to live state shape.
 */
export function exportCsv(filename: string, header: string[], rows: (string | number)[][]): void {
  const esc = (v: string | number): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.map(esc).join(',')];
  for (const r of rows) lines.push(r.map(esc).join(','));
  downloadBlob(lines.join('\n'), `${safe(filename)}-${stamp()}.csv`, 'text/csv');
}

function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_') || 'export';
}
