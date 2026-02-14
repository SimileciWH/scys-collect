function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function readCsvFile(fs, filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error(`CSV is empty: ${filePath}`);
  const header = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((l) => parseCsvLine(l));
  return { header, rows };
}

function findCol(header, name) {
  const idx = header.findIndex((h) => norm(h) === name);
  if (idx === -1) throw new Error(`Column not found: ${name}`);
  return idx;
}

module.exports = {
  norm,
  parseCsvLine,
  readCsvFile,
  findCol
};

