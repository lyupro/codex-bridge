/** Renders generic rows within terminal width. */

const asText = (value) => {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
};

/** Counts printable code points without imposing a dependency on terminal libraries. */
export const displayWidth = (value) => Array.from(String(value)).length;

/** Keeps the right side of a name when a flexible column must shrink. */
export function truncateStart(value, width) {
  const text = String(value);
  if (displayWidth(text) <= width) return text;
  if (width <= 1) return '…';
  return `…${Array.from(text).slice(-(width - 1)).join('')}`;
}

function fit(value, width, mode) {
  if (displayWidth(value) <= width) return value;
  if (mode === 'start') return truncateStart(value, width);
  if (mode === 'end') return `${Array.from(value).slice(0, Math.max(0, width - 1)).join('')}…`;
  return value;
}

function normalizeColumn(column) {
  const kind = column.kind || 'text';
  const fixed = column.fixed === true || kind === 'number' || kind === 'date';
  return {
    ...column,
    key: String(column.key ?? column.label ?? column.header),
    header: String(column.header ?? column.label ?? column.key),
    kind,
    align: column.align || (kind === 'number' ? 'right' : 'left'),
    mode: column.truncate === undefined ? (fixed ? null : 'start') : column.truncate,
  };
}

function optionsWidth(options) {
  if (typeof options === 'number') return options;
  const value = options?.width ?? options?.terminalWidth ?? process.stdout.columns;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 80;
}

function rowValue(row, column) {
  return asText(typeof column.value === 'function' ? column.value(row) : row?.[column.key]);
}

function columnWidths(columns, rows, width) {
  const values = columns.map((column) => [
    column.header,
    ...rows.map((row) => rowValue(row, column)),
  ]);
  const widths = values.map((items) => Math.max(...items.map(displayWidth), 1));
  const gaps = Math.max(0, columns.length - 1);
  let spare = width - gaps - widths.reduce((sum, item) => sum + item, 0);
  if (spare >= 0) return widths;

  const flexible = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => column.mode === 'start' || column.mode === 'end');
  while (spare < 0) {
    let changed = false;
    for (const { column, index } of flexible) {
      const minimum = Math.max(1, Number(column.minWidth) || 1);
      if (widths[index] <= minimum) continue;
      widths[index] -= 1;
      spare += 1;
      changed = true;
      if (spare === 0) break;
    }
    if (!changed) break;
  }
  return widths;
}

function renderRow(row, columns, widths, header = false) {
  return columns.map((column, index) => {
    const value = header ? column.header : rowValue(row, column);
    const rendered = fit(value, widths[index], header ? null : column.mode);
    const padding = Math.max(0, widths[index] - displayWidth(rendered));
    if (index === columns.length - 1) {
      return column.align === 'right' ? `${' '.repeat(padding)}${rendered}` : rendered;
    }
    return column.align === 'right'
      ? `${' '.repeat(padding)}${rendered}`
      : `${rendered}${' '.repeat(padding)}`;
  }).join(' ');
}

// Columns first, rows second, always. Sniffing which argument is which would let a caller with an
// empty column list silently render the wrong shape instead of failing where the mistake is.
/** Renders column descriptors plus object rows as a plain table. */
export function renderTable(columns, rows, options = {}) {
  const normalized = (columns || []).map(normalizeColumn);
  if (!normalized.length) return '';
  const values = Array.isArray(rows) ? rows : [];
  const widths = columnWidths(normalized, values, optionsWidth(options));
  return [
    renderRow(null, normalized, widths, true),
    ...values.map((row) => renderRow(row, normalized, widths)),
  ].join('\n');
}
