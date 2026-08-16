/**
 * RSVP export (D7.6).
 *
 * Two hazards, and neither is theoretical.
 *
 * **Formula injection.** A guest chooses their own name. Excel treats a cell
 * beginning `=`, `+`, `-`, `@` — or a tab or carriage return — as a formula,
 * so a name like `=cmd|'/c calc'!A0` becomes code that runs on the couple's
 * laptop when they open the guest list. The mitigation is to make such a cell
 * unambiguously text, and it has to happen at export rather than at input:
 * the guest's actual name belongs in the database unaltered, because it is
 * their name and it is shown on a screen where it is only ever text.
 *
 * **Arabic in Excel.** Excel on Windows reads a CSV in the system code page
 * unless a UTF-8 byte-order mark tells it otherwise, so an Arabic guest list
 * opens as mojibake — which for this product is the whole file being useless.
 * The BOM is not decoration.
 */

/** Excel begins evaluating a cell when it starts with one of these. */
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Makes one value safe to open in a spreadsheet.
 *
 * A leading apostrophe is what Excel and LibreOffice both read as "this cell
 * is text"; it is consumed on display, so the couple sees the name as typed.
 * Everything else is ordinary CSV quoting.
 */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);

  const defused = text.length > 0 && FORMULA_TRIGGERS.has(text[0] as string) ? `'${text}` : text;

  // Quote whenever the value could otherwise break the row apart. Doubling the
  // inner quotes is the RFC 4180 escape.
  const needsQuoting = /[",\n\r\t]/.test(defused) || defused.startsWith("'");
  return needsQuoting ? `"${defused.replaceAll('"', '""')}"` : defused;
}

export interface CsvColumn<Row> {
  readonly header: string;
  readonly value: (row: Row) => unknown;
}

/** UTF-8 BOM. Without it Excel on Windows renders Arabic as mojibake. */
export const UTF8_BOM = '﻿';

export function toCsv<Row>(rows: readonly Row[], columns: readonly CsvColumn<Row>[]): string {
  const lines = [columns.map((column) => csvCell(column.header)).join(',')];

  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(column.value(row))).join(','));
  }

  // CRLF, because that is what RFC 4180 specifies and what Excel expects.
  return `${UTF8_BOM}${lines.join('\r\n')}\r\n`;
}

export interface RsvpExportRow {
  readonly name: string;
  readonly attending: boolean;
  readonly partySize: number;
  readonly phone: string | null;
  readonly note: string | null;
  readonly submittedAt: Date;
  readonly source: string;
}

/**
 * The guest list, in the invitation's language.
 *
 * Headers are translated because the file is opened by the couple, not by us,
 * and a column called "attending" above Arabic names is a small daily
 * insult in a product whose whole point is that it is theirs.
 */
export function rsvpExportColumns(locale: 'ar' | 'en'): readonly CsvColumn<RsvpExportRow>[] {
  const arabic = locale === 'ar';
  return [
    { header: arabic ? 'الاسم' : 'Name', value: (row) => row.name },
    {
      header: arabic ? 'الحضور' : 'Attending',
      value: (row) => (arabic ? (row.attending ? 'نعم' : 'لا') : row.attending ? 'Yes' : 'No'),
    },
    { header: arabic ? 'عدد الأشخاص' : 'Party size', value: (row) => row.partySize },
    { header: arabic ? 'الجوال' : 'Phone', value: (row) => row.phone ?? '' },
    { header: arabic ? 'ملاحظات' : 'Note', value: (row) => row.note ?? '' },
    {
      header: arabic ? 'وقت الرد' : 'Submitted at',
      // ISO-8601, not a localised date: a spreadsheet sorts it correctly as
      // text, and it is unambiguous about which is the day and which the month.
      value: (row) => row.submittedAt.toISOString(),
    },
    { header: arabic ? 'المصدر' : 'Source', value: (row) => row.source },
  ];
}

export function rsvpCsv(rows: readonly RsvpExportRow[], locale: 'ar' | 'en'): string {
  return toCsv(rows, rsvpExportColumns(locale));
}
