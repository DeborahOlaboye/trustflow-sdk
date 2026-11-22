import {
  parseCsv,
  parseCsvRecords,
  runCsvBatch,
  submitBatchRows,
  validateBatchRows,
} from '../src/utils/batch';
import { isValidStellarAddress } from '../src/utils/validation';
import { TrustFlowError } from '../src/errors';

const GOOD = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const ALSO_GOOD = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFDAGORAC526G22TYOXA2';

/** Returns whatever `fn` throws, so the error's fields can be asserted. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the function to throw');
}

describe('parseCsv', () => {
  it('splits rows and cells, with LF and CRLF endings', () => {
    expect(parseCsv('a,b\n1,2\r\n3,4')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('keeps commas, newlines and doubled quotes inside quoted fields', () => {
    expect(parseCsv('name,note\n"Doe, Jane","said ""hi""\nthere"\n')).toEqual([
      ['name', 'note'],
      ['Doe, Jane', 'said "hi"\nthere'],
    ]);
  });

  it('drops blank lines and a leading byte order mark', () => {
    expect(parseCsv('﻿a,b\n\n1,2\n\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('rejects a quoted field that never closes', () => {
    expect(thrownBy(() => parseCsv('a,"unterminated\n1,2'))).toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});

describe('parseCsvRecords', () => {
  it('keys each data row by the trimmed header names', () => {
    expect(parseCsvRecords(' recipient , amount \n' + `${GOOD}, 10 \n${ALSO_GOOD},20\n`)).toEqual(
      [
        { recipient: GOOD, amount: '10' },
        { recipient: ALSO_GOOD, amount: '20' },
      ],
    );
  });

  it('rejects an empty file', () => {
    expect(thrownBy(() => parseCsvRecords(''))).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a repeated header name', () => {
    expect(thrownBy(() => parseCsvRecords('amount,amount\n1,2\n'))).toMatchObject({
      code: 'VALIDATION_ERROR',
      field: 'amount',
    });
  });

  it('reports every row with the wrong number of cells, not just the first', () => {
    const caught = thrownBy(() =>
      parseCsvRecords('recipient,amount\nonly-one-cell\nA,B,C\n' + `${GOOD},1\n`),
    );
    expect(caught).toBeInstanceOf(TrustFlowError);
    const issues = (caught as TrustFlowError).issues as Array<{ row: number }>;
    expect(issues.map((i) => i.row)).toEqual([1, 2]);
  });
});

describe('validateBatchRows', () => {
  const records = [
    { recipient: GOOD, amount: '1' },
    { recipient: 'not-a-key', amount: '2' },
    { recipient: ALSO_GOOD, amount: '3' },
    { recipient: 'also-bad', amount: '4' },
  ];

  it('returns every validated row in order when all pass', () => {
    const valid = validateBatchRows([records[0]!, records[2]!], (row) => ({
      to: row.recipient,
    }));
    expect(valid).toEqual([{ to: GOOD }, { to: ALSO_GOOD }]);
  });

  it('rejects the whole batch and names every bad row, without running any submission', () => {
    const validate = (row: { recipient: string }, rowNumber: number) => {
      if (!isValidStellarAddress(row.recipient)) {
        throw new Error(`row ${rowNumber} has an invalid recipient`);
      }
      return row;
    };

    const caught = thrownBy(() => validateBatchRows(records, validate));

    expect(caught).toBeInstanceOf(TrustFlowError);
    const error = caught as TrustFlowError;
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toContain('2 of 4 rows are invalid');
    expect(error.message).toContain('row 2: row 2 has an invalid recipient');
    expect(error.message).toContain('row 4: row 4 has an invalid recipient');
    expect((error.issues as Array<{ row: number }>).map((i) => i.row)).toEqual([2, 4]);
  });
});

describe('submitBatchRows', () => {
  it('submits in order and returns every result', async () => {
    const submit = jest.fn(async (row: number, _rowNumber: number) => row * 10);

    await expect(submitBatchRows([1, 2, 3], submit)).resolves.toEqual({
      results: [10, 20, 30],
      submitted: 3,
    });
    expect(submit.mock.calls.map((call) => call[1])).toEqual([1, 2, 3]);
  });

  it('stops at the first failure and reports where to resume', async () => {
    const boom = new Error('network down');
    const submit = jest.fn(async (row: number, _rowNumber: number) => {
      if (row === 3) throw boom;
      return row;
    });

    const report = await submitBatchRows([1, 2, 3, 4, 5], submit);

    expect(report).toEqual({ results: [1, 2], submitted: 2, failedRow: 3, error: boom });
    // Rows 4 and 5 were never attempted.
    expect(submit).toHaveBeenCalledTimes(3);
  });
});

describe('runCsvBatch', () => {
  const csv = `recipient,amount\n${GOOD},1\n${ALSO_GOOD},2\n`;

  it('validates every row and then submits each one', async () => {
    const submit = jest.fn(async (row: { to: string }) => `paid ${row.to}`);

    const report = await runCsvBatch(csv, {
      validate: (record) => ({ to: record.recipient }),
      submit,
    });

    expect(report.submitted).toBe(2);
    expect(report.results).toEqual([`paid ${GOOD}`, `paid ${ALSO_GOOD}`]);
  });

  it('submits nothing when any row is invalid, even when the bad row is last', async () => {
    const submit = jest.fn(async () => 'ok');
    const bad = `recipient,amount\n${GOOD},1\n${ALSO_GOOD},2\nnot-a-key,3\n`;

    await expect(
      runCsvBatch(bad, {
        validate: (record, rowNumber) => {
          if (!isValidStellarAddress(record.recipient)) {
            throw new Error(`row ${rowNumber}: invalid public key`);
          }
          return record;
        },
        submit,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(submit).not.toHaveBeenCalled();
  });
});
