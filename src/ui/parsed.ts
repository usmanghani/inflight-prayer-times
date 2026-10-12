/** Convert parser / AI output (ParsedLeg-shaped) into editable drafts. */
import type { Airport } from '../types';
import { localToUtc } from '../time/tz';
import { blankLeg, type LegDraft } from './model';

export interface ParsedLike {
  flightNumber?: string;
  from?: string;
  to?: string;
  depDate?: string;
  depTime?: string;
  arrDate?: string;
  arrTime?: string;
  confidence: number;
  raw?: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;

function addDays(date: string, n: number): string {
  const t = new Date(date + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

function hhmm(t: string): string {
  const [h, m] = t.split(':');
  return `${h.padStart(2, '0')}:${m}`;
}

/** Build drafts from parsed legs; everything is flagged `needsReview`. */
export function parsedToDrafts(parsed: ParsedLike[], resolve: (iata: string) => Airport | undefined): LegDraft[] {
  return parsed.slice(0, 10).map((p) => {
    const from = p.from ? resolve(p.from.toUpperCase()) : undefined;
    const to = p.to ? resolve(p.to.toUpperCase()) : undefined;
    const depDate = p.depDate && DATE_RE.test(p.depDate) ? p.depDate : '';
    const depTime = p.depTime && TIME_RE.test(p.depTime) ? hhmm(p.depTime) : '';
    const arrTime = p.arrTime && TIME_RE.test(p.arrTime) ? hhmm(p.arrTime) : '';
    let arrDate = p.arrDate && DATE_RE.test(p.arrDate) ? p.arrDate : '';

    const depLocal = depDate && depTime ? `${depDate}T${depTime}` : '';
    let note: string | undefined;

    // No explicit arrival date: pick the first of day+0..+2 that gives a plausible block time.
    if (!arrDate && depDate && arrTime) {
      arrDate = depDate;
      if (from && to && depLocal) {
        try {
          const dep = localToUtc(depLocal, from.tz).getTime();
          for (let k = 0; k <= 2; k++) {
            const arr = localToUtc(`${addDays(depDate, k)}T${arrTime}`, to.tz).getTime();
            const hrs = (arr - dep) / 3600000;
            if (hrs >= 0.4 && hrs <= 22) {
              arrDate = addDays(depDate, k);
              break;
            }
          }
        } catch {
          /* keep same-day guess */
        }
      }
      note = 'The arrival date was not printed; it was inferred from the flight duration.';
    }
    const arrLocal = arrDate && arrTime ? `${arrDate}T${arrTime}` : '';

    return blankLeg({
      flightNumber: (p.flightNumber ?? '').toUpperCase().slice(0, 10),
      from: from ? from.iata : (p.from ?? '').toUpperCase().slice(0, 8),
      to: to ? to.iata : (p.to ?? '').toUpperCase().slice(0, 8),
      depLocal,
      arrLocal,
      needsReview: true,
      confidence: p.confidence,
      note,
    });
  });
}
