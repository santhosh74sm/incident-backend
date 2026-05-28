'use strict';

const MAX_SPREADSHEET_ROWS = Number(process.env.SPREADSHEET_MAX_ROWS) || 5000;
const MAX_SPREADSHEET_COLUMNS = Number(process.env.SPREADSHEET_MAX_COLUMNS) || 80;

const createSpreadsheetError = (message) => {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
};

const assertWorksheetBounds = (XLSX, worksheet) => {
    if (!worksheet?.['!ref']) {
        throw createSpreadsheetError('Spreadsheet does not contain a readable sheet.');
    }

    const range = XLSX.utils.decode_range(worksheet['!ref']);
    const rowCount = range.e.r - range.s.r + 1;
    const columnCount = range.e.c - range.s.c + 1;

    if (rowCount > MAX_SPREADSHEET_ROWS) {
        throw createSpreadsheetError(`Spreadsheet exceeds the maximum ${MAX_SPREADSHEET_ROWS} rows.`);
    }

    if (columnCount > MAX_SPREADSHEET_COLUMNS) {
        throw createSpreadsheetError(`Spreadsheet exceeds the maximum ${MAX_SPREADSHEET_COLUMNS} columns.`);
    }
};

const safeSheetToJson = (XLSX, worksheet, options = {}) => {
    assertWorksheetBounds(XLSX, worksheet);
    return XLSX.utils.sheet_to_json(worksheet, {
        defval: '',
        raw: false,
        ...options,
    });
};

module.exports = {
    assertWorksheetBounds,
    safeSheetToJson,
};
