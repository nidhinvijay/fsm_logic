import fs from 'fs';
import path from 'path';

interface SummaryRow {
  type: 'SIGNAL' | 'WEBHOOK';
  time: string;
  info: string;
}

function main() {
  const dateArg = process.argv[2]; // expected: YYYY-MM-DD
  if (!dateArg) {
    console.error('Usage: ts-node scripts/dailySummary.ts YYYY-MM-DD');
    process.exit(1);
  }

  const [year, month, day] = dateArg.split('-');
  if (!year || !month || !day) {
    console.error('Date must be in format YYYY-MM-DD');
    process.exit(1);
  }

  const targetDatePrefix = `${day.padStart(2, '0')}/${month.padStart(
    2,
    '0',
  )}/${year}`; // matches IST log prefix "DD/MM/YYYY"

  const logPath = path.join(__dirname, '..', 'logs', 'fsm.log');
  if (!fs.existsSync(logPath)) {
    console.error(`Log file not found at ${logPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split(/\r?\n/);

  const rows: SummaryRow[] = [];

  for (const line of lines) {
    if (!line.startsWith(targetDatePrefix)) continue;

    const timeMatch = line.match(
      /^(\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}) \[.+?\] (.+)$/u,
    );
    if (!timeMatch) continue;
    const timeStr = timeMatch[1];
    const msg = timeMatch[2];

    if (msg.includes('BUY_SIGNAL entered') || msg.includes('SELL_SIGNAL entered')) {
      rows.push({
        type: 'SIGNAL',
        time: timeStr,
        info: msg,
      });
      continue;
    }

    if (msg.startsWith('Sending live webhook')) {
      // Try to extract kind and refPrice
      let info = msg;
      const kindMatch = msg.match(/"kind":"([^"]+)"/);
      const priceMatch = msg.match(/"refPrice":([\d.]+)/);
      if (kindMatch && priceMatch) {
        info = `Sending live webhook kind=${kindMatch[1]} refPrice=${priceMatch[1]}`;
      }
      rows.push({
        type: 'WEBHOOK',
        time: timeStr,
        info,
      });
    }
  }

  if (rows.length === 0) {
    console.log(`No entries found in logs/fsm.log for ${dateArg} (IST).`);
    return;
  }

  console.log(`TYPE,TIME(IST),DETAILS`);
  for (const row of rows) {
    // Basic CSV escaping: wrap info in quotes and replace any quotes inside
    const safeInfo = `"${row.info.replace(/"/g, '""')}"`;
    console.log(`${row.type},${row.time},${safeInfo}`);
  }
}

main();

