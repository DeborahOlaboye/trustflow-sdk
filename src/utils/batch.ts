import { TrustFlowError } from '../errors';

/**
 * Batch helpers for scripts that submit many rows, such as bulk payouts from a
 * CSV file (#777).
 *
 * The rule these helpers enforce: **validate every row before the first
 * submission.** A malformed row found on row 51 must not be discovered after
 * rows 1–50 have already gone on-chain. {@link runCsvBatch} and
 * {@link validateBatchRows} reject the whole batch, naming every bad row,
 * before `submit` is called once.
 *
 * Row numbers are 1-based and count data rows only, so the header is not
 * counted. Row 1 is the first line under the header.
 */

/** One parsed CSV record, keyed by the header names. */
export type CsvRecord = Record<string, string>;

/** A problem found in one row, reported with its 1-based row number. */
export interface BatchRowIssue {
  row: number;
  message: string;
}

/** Outcome of {@link submitBatchRows}. */
export interface BatchSubmitReport<TResult> {
  /** Results of the rows that succeeded, in row order. */
  results: TResult[];
  /** Number of rows submitted successfully. */
  submitted: number;
  /**
   * 1-based number of the row whose submission failed. Absent when every row
   * succeeded. Resume with `rows.slice(failedRow - 1)`.
   */
  failedRow?: number;
  /** The error that stopped the batch. Absent when every row succeeded. */
  error?: unknown;
}

/** Maximum number of row problems listed in one error message. */
const MAX_LISTED_ISSUES = 20;

/**
 * Splits CSV text into rows of cells. Handles quoted fields, `""` escapes,
 * commas and newlines inside quotes, CRLF or LF line endings, a leading byte
 * order mark, and blank lines (which are dropped).
 *
 * @param text - Raw CSV text
 * @returns Rows of cells, with the header row first
 * @throws {TrustFlowError} `VALIDATION_ERROR` when a quoted field never closes
 *
 * @example
 * ```typescript
 * parseCsv('a,b\n"x, y",2\n');
 * // [['a', 'b'], ['x, y', '2']]
 * ```
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; ) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
    } else if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i += 1;
    }
  }

  if (inQuotes) {
    throw new TrustFlowError('CSV ends inside a quoted field', 'VALIDATION_ERROR');
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => !(cells.length === 1 && cells[0] === ''));
}

/**
 * Parses CSV text whose first line is a header into one record per data row.
 * Header names and cell values are trimmed.
 *
 * @param text - Raw CSV text with a header row
 * @returns One record per data row
 * @throws {TrustFlowError} `VALIDATION_ERROR` when the header is missing,
 *   repeats a name, or a row has a different number of cells than the header.
 *   Every width mismatch is reported together, before anything is submitted.
 *
 * @example
 * ```typescript
 * const rows = parseCsvRecords('recipient,amount\nGABC...,10\n');
 * // [{ recipient: 'GABC...', amount: '10' }]
 * ```
 */
export function parseCsvRecords(text: string): CsvRecord[] {
  const [header, ...body] = parseCsv(text);
  if (!header) {
    throw new TrustFlowError('CSV is empty; expected a header row', 'VALIDATION_ERROR');
  }

  const names = header.map((name) => name.trim());
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) {
    throw new TrustFlowError(
      `CSV header repeats the column "${duplicate}"`,
      'VALIDATION_ERROR',
      undefined,
      duplicate,
    );
  }

  const issues: BatchRowIssue[] = [];
  const records: CsvRecord[] = [];
  body.forEach((cells, index) => {
    if (cells.length !== names.length) {
      issues.push({
        row: index + 1,
        message: `expected ${names.length} columns, found ${cells.length}`,
      });
      return;
    }
    const record: CsvRecord = {};
    names.forEach((name, column) => {
      record[name] = cells[column]!.trim();
    });
    records.push(record);
  });

  if (issues.length > 0) throw rejectBatch(issues, body.length);
  return records;
}

/**
 * Builds the error that rejects a whole batch and lists its problems.
 */
function rejectBatch(issues: BatchRowIssue[], total: number): TrustFlowError {
  const listed = issues
    .slice(0, MAX_LISTED_ISSUES)
    .map((issue) => `  row ${issue.row}: ${issue.message}`);
  const more =
    issues.length > MAX_LISTED_ISSUES ? `\n  ...and ${issues.length - MAX_LISTED_ISSUES} more` : '';
  return new TrustFlowError(
    `Batch rejected before any submission: ${issues.length} of ${total} rows are invalid.\n` +
      listed.join('\n') +
      more,
    'VALIDATION_ERROR',
    undefined,
    undefined,
    issues,
  );
}

/**
 * Runs `validate` on every row and throws if any row fails. Nothing is
 * submitted by this function, so it is safe to call before a batch starts.
 *
 * @param rows - Rows to check
 * @param validate - Returns the validated, typed row, or throws with the reason
 * @returns The validated rows, in order
 * @throws {TrustFlowError} `VALIDATION_ERROR` listing every failing row. The
 *   error's `issues` property holds the same list as {@link BatchRowIssue}s.
 *
 * @example
 * ```typescript
 * const payouts = validateBatchRows(records, (row, n) => {
 *   if (!isValidStellarAddress(row.recipient)) throw new Error('invalid recipient');
 *   return { recipient: row.recipient, amount: row.amount };
 * });
 * ```
 */
export function validateBatchRows<TRow, TValid>(
  rows: readonly TRow[],
  validate: (row: TRow, rowNumber: number) => TValid,
): TValid[] {
  const valid: TValid[] = [];
  const issues: BatchRowIssue[] = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    try {
      valid.push(validate(row, rowNumber));
    } catch (error) {
      issues.push({
        row: rowNumber,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  if (issues.length > 0) throw rejectBatch(issues, rows.length);
  return valid;
}

/**
 * Submits validated rows one at a time, in order, and stops at the first
 * failure. It does not throw for a submission failure. The report says which
 * row failed, so the caller can resume from there.
 *
 * @param rows - Rows that already passed validation
 * @param submit - Submits one row and resolves with its result
 * @returns A report with the results so far and, on failure, where it stopped
 *
 * @example
 * ```typescript
 * const report = await submitBatchRows(valid, (row) => client.createEscrow(row));
 * if (report.failedRow !== undefined) {
 *   // Retry later with the rows that were not submitted:
 *   const remaining = valid.slice(report.failedRow - 1);
 * }
 * ```
 */
export async function submitBatchRows<TValid, TResult>(
  rows: readonly TValid[],
  submit: (row: TValid, rowNumber: number) => Promise<TResult>,
): Promise<BatchSubmitReport<TResult>> {
  const results: TResult[] = [];
  for (let index = 0; index < rows.length; index++) {
    try {
      results.push(await submit(rows[index]!, index + 1));
    } catch (error) {
      return { results, submitted: results.length, failedRow: index + 1, error };
    }
  }
  return { results, submitted: results.length };
}

/**
 * Parses CSV text, validates every row, and only then submits. A bad file
 * fails before the first on-chain side effect.
 *
 * @param text - Raw CSV text with a header row
 * @param options.validate - Returns the typed row for one CSV record, or throws
 * @param options.submit - Submits one validated row
 * @returns The submission report from {@link submitBatchRows}
 * @throws {TrustFlowError} `VALIDATION_ERROR` when the CSV or any row is invalid.
 *   No row is submitted in that case.
 *
 * @example
 * ```typescript
 * import { isValidStellarAddress, runCsvBatch } from '@trustflow/sdk/utils';
 *
 * const report = await runCsvBatch(fs.readFileSync('payouts.csv', 'utf8'), {
 *   validate: (row) => {
 *     if (!isValidStellarAddress(row.recipient)) throw new Error('bad recipient');
 *     return { recipient: row.recipient, amount: BigInt(row.amount) };
 *   },
 *   submit: (payout) => sendPayout(payout),
 * });
 * console.log(`${report.submitted} rows submitted`);
 * ```
 */
export async function runCsvBatch<TValid, TResult>(
  text: string,
  options: {
    validate: (record: CsvRecord, rowNumber: number) => TValid;
    submit: (row: TValid, rowNumber: number) => Promise<TResult>;
  },
): Promise<BatchSubmitReport<TResult>> {
  const records = parseCsvRecords(text);
  const valid = validateBatchRows(records, options.validate);
  return submitBatchRows(valid, options.submit);
}
