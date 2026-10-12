import { describe, it, expect } from 'vitest';
import {
  mergeParsedLegs,
  pageSeparator,
  parseItineraryPages,
  parseItineraryText,
  stripPageSeparators,
  type ParsedLeg,
} from '../src/ocr/parseItinerary';
import { isKnownIata } from '../src/data/airports';

const referenceDate = new Date(Date.UTC(2026, 9, 1));
const parse = (t: string): ParsedLeg[] => parseItineraryText(t, { isKnownIata, referenceDate });

describe('parseItineraryText', () => {
  it('Emirates e-ticket (header first, labelled Departure/Arrival)', () => {
    const text = `
E-TICKET ITINERARY RECEIPT
Booking reference: 7XK2PL     Ticket number: 176-2401234567
Passenger: KHAN/USMAN MR
Flight EK 601   Economy (Y)   Operated by Emirates
Departure: Mon 12 Oct 2026  02:55   Karachi (KHI)  Terminal 1
Arrival:   Mon 12 Oct 2026  04:20   Dubai (DXB)  Terminal 3
Flight EK 225   Economy (Y)   Operated by Emirates
Departure: Mon 12 Oct 2026  09:55   Dubai (DXB)  Terminal 3
Arrival:   Mon 12 Oct 2026  15:05   San Francisco (SFO)  Terminal I
Baggage: 2 pieces   Seat 41K
`;
    const legs = parse(text);
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({
      flightNumber: 'EK601', from: 'KHI', to: 'DXB',
      depDate: '2026-10-12', depTime: '02:55', arrDate: '2026-10-12', arrTime: '04:20',
    });
    expect(legs[1]).toMatchObject({
      flightNumber: 'EK225', from: 'DXB', to: 'SFO',
      depDate: '2026-10-12', depTime: '09:55', arrDate: '2026-10-12', arrTime: '15:05',
    });
    expect(legs[0].confidence).toBeGreaterThan(0.9);
    expect(legs[0].raw.length).toBeGreaterThan(0);
  });

  it('Qatar Airways confirmation (date + time on one line, no spaces in flight number)', () => {
    const text = `
Your trip to San Francisco
QR605  Karachi (KHI) to Doha (DOH)
12 Oct 2026, 06:30 - 12 Oct 2026, 07:40
QR735  Doha (DOH) to San Francisco (SFO)
12 Oct 2026, 11:05 - 12 Oct 2026, 16:55
Booking Ref: PNR 9ABCDE`;
    const legs = parse(text);
    expect(legs.map((l) => l.flightNumber)).toEqual(['QR605', 'QR735']);
    expect(legs[0]).toMatchObject({ from: 'KHI', to: 'DOH', depDate: '2026-10-12', depTime: '06:30', arrTime: '07:40' });
    expect(legs[1]).toMatchObject({ from: 'DOH', to: 'SFO', depTime: '11:05', arrTime: '16:55' });
  });

  it('United itinerary: 12-hour clock, Oct 12, 2026 dates, +1 next-day marker', () => {
    const text = `
Flight 1 of 1
UA 863  Operated by United Airlines
Mon, Oct 12, 2026
Depart  San Francisco, CA (SFO)  6:30 PM
Arrive  Delhi, India (DEL)  9:20 PM +1
Seat 32A`;
    const legs = parse(text);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({
      flightNumber: 'UA863', from: 'SFO', to: 'DEL',
      depDate: '2026-10-12', depTime: '18:30', arrDate: '2026-10-13', arrTime: '21:20',
    });
  });

  it('12:xx AM / PM edge cases', () => {
    const legs = parse('UA 1  EWR -> SFO  12:05 AM - 12:45 PM  Oct 12, 2026');
    expect(legs[0]).toMatchObject({ flightNumber: 'UA1', from: 'EWR', to: 'SFO', depTime: '00:05', arrTime: '12:45' });
  });

  it('PIA / GDS style: compact dates, glued city pair, 4-digit times', () => {
    const text = `
PK 301  12OCT  KHI ISB  0830 1015
PK 785  14OCT  ISB LHE  0700 0755
`;
    const legs = parse(text);
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ flightNumber: 'PK301', from: 'KHI', to: 'ISB', depDate: '2026-10-12', depTime: '08:30', arrTime: '10:15' });
    expect(legs[1]).toMatchObject({ flightNumber: 'PK785', from: 'ISB', to: 'LHE', depDate: '2026-10-14', depTime: '07:00', arrTime: '07:55' });
  });

  it('Glued GDS airport pair (KHIDXB)', () => {
    const legs = parse('EK 601 12OCT KHIDXB 0255 0420');
    expect(legs[0]).toMatchObject({ flightNumber: 'EK601', from: 'KHI', to: 'DXB', depTime: '02:55', arrTime: '04:20', depDate: '2026-10-12' });
  });

  it('Turkish Airlines with DD.MM.YYYY dates and 24h times', () => {
    const text = `
TK 708   Karachi KHI   12.10.2026  04:30
         Istanbul IST  12.10.2026  08:20
TK 79    Istanbul IST  12.10.2026  12:05
         San Francisco SFO  12.10.2026  15:00
`;
    const legs = parse(text);
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ flightNumber: 'TK708', from: 'KHI', to: 'IST', depDate: '2026-10-12', depTime: '04:30', arrTime: '08:20' });
    expect(legs[1]).toMatchObject({ flightNumber: 'TK79', from: 'IST', to: 'SFO', depTime: '12:05', arrTime: '15:00' });
  });

  it('DD/MM vs MM/DD numeric dates', () => {
    expect(parse('EK 2 LHR - DXB 13/10/2026 14:20 00:25')[0].depDate).toBe('2026-10-13'); // DD/MM
    expect(parse('EK 2 LHR - DXB 10/13/2026 14:20 00:25')[0].depDate).toBe('2026-10-13'); // MM/DD (13 cannot be a month)
    expect(parse('EK 2 LHR - DXB 05/10/2026 14:20 00:25')[0].depDate).toBe('2026-10-05'); // ambiguous -> DD/MM
  });

  it('Google Flights / Expedia copy-paste (times first, airline + number in the middle)', () => {
    const text = `
Tue, Oct 13
9:30 PM – 11:50 PM
Emirates EK 226 · Boeing 777
SFO – DXB
15 hr 50 min
`;
    const legs = parse(text);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ flightNumber: 'EK226', from: 'SFO', to: 'DXB', depDate: '2026-10-13', depTime: '21:30', arrTime: '23:50' });
  });

  it('Expedia style multi-leg with durations, layover and arrival date change', () => {
    const text = `
Departure Mon, Oct 12
SFO 4:35 PM -> DXB 7:55 PM+1
EK 226 | 15h 20m
Layover 8 hr 10 min in Dubai (DXB)
DXB 4:05 AM -> KHI 7:25 AM
EK 600 | 2h 20m
`;
    const legs = parse(text);
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ flightNumber: 'EK226', from: 'SFO', to: 'DXB', depDate: '2026-10-12', depTime: '16:35', arrDate: '2026-10-13', arrTime: '19:55' });
    expect(legs[1]).toMatchObject({ flightNumber: 'EK600', from: 'DXB', to: 'KHI', depTime: '04:05', arrTime: '07:25' });
    // missing date is inferred from the previous arrival at the same airport: 04:05 < 19:55 => next day
    expect(legs[1].depDate).toBe('2026-10-14');
  });

  it('noisy OCR: pipes, O for 0, stray spaces, mixed separators', () => {
    const text = `
| FLIGHT |  EK 6O1  | 12 OCT 2O26 |
| KHI  ->  DXB |  O2:55  |  O4:2O |
|  EK  225 |  12 OCT  2026 |
| DXB - SFO |  O9:55 |  15:O5 |
`;
    const legs = parse(text);
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ flightNumber: 'EK601', from: 'KHI', to: 'DXB', depDate: '2026-10-12', depTime: '02:55', arrTime: '04:20' });
    expect(legs[1]).toMatchObject({ flightNumber: 'EK225', from: 'DXB', to: 'SFO', depTime: '09:55', arrTime: '15:05' });
  });

  it('21h30 style and unicode arrows / NBSP', () => {
    const legs = parse('AF 83  SFO → CDG  15 oct 2026  15h15  10h05 +1');
    expect(legs[0]).toMatchObject({ flightNumber: 'AF83', from: 'SFO', to: 'CDG', depTime: '15:15', arrTime: '10:05', depDate: '2026-10-15', arrDate: '2026-10-16' });
  });

  it('dedupes repeated flight numbers (summary + details)', () => {
    const text = `
SUMMARY
EK 601  KHI - DXB   12 Oct 2026
DETAILS
Flight EK 601  Departure 02:55 Karachi (KHI)  Arrival 04:20 Dubai (DXB)
`;
    const legs = parse(text);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ flightNumber: 'EK601', from: 'KHI', to: 'DXB', depDate: '2026-10-12', depTime: '02:55', arrTime: '04:20' });
  });

  it('infers the year from the reference date (rolls to next year when the date has passed)', () => {
    const legs = parseItineraryText('EK 202 DXB - JFK  Mon, 4 Jan  02:55  08:20', {
      isKnownIata,
      referenceDate: new Date(Date.UTC(2026, 9, 1)),
    });
    expect(legs[0].depDate).toBe('2027-01-04'); // Monday in 2027
  });

  it('does not mistake common words, months or weekdays for airports', () => {
    const text = `
THE PNR AND ETA ARE NOT AVAILABLE. NON REFUNDABLE. SEAT 12A
SAT 12 OCT 21:30 SUN MON TUE WED THU FRI JAN FEB MAR APR MAY JUN JUL AUG SEP NOV DEC
FOR ALL YOU CAN GET
`;
    const legs = parse(text);
    for (const l of legs) {
      expect(l.from).toBeUndefined();
      expect(l.to).toBeUndefined();
    }
  });

  it('only accepts known IATA codes, and only in an airport-like context', () => {
    // XYZ is not a real airport here; "CAN" is a real IATA code (Guangzhou) but a common word
    const legs = parse('EK 601 We CAN fly XYZ - DXB 02:55 04:20');
    expect(legs[0].from).not.toBe('CAN');
    expect(legs[0].from).not.toBe('XYZ');
  });

  it('does not read years, prices or PM 12 as flights/times', () => {
    const legs = parse('Total USD 1,250.00  9:30 PM 12 Oct 2026  EK 601  KHI - DXB  21:30  23:50');
    expect(legs).toHaveLength(1);
    expect(legs[0].flightNumber).toBe('EK601');
    expect(legs[0].depTime).toBe('21:30');
    expect(legs[0].arrTime).toBe('23:50');
  });

  it('ignores boarding / check-in / duration times', () => {
    const text = `
EK 601  Karachi (KHI) 02:55  Dubai (DXB) 04:20
Boarding 02:15   Check-in closes 01:15   Duration 2h 25m
`;
    const legs = parse(text);
    expect(legs[0]).toMatchObject({ depTime: '02:55', arrTime: '04:20' });
  });

  it('works without any flight number (airports + times only)', () => {
    const legs = parse('Karachi (KHI) 21:30 -> Dubai (DXB) 23:50');
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ from: 'KHI', to: 'DXB', depTime: '21:30', arrTime: '23:50' });
    expect(legs[0].flightNumber).toBeUndefined();
    expect(legs[0].confidence).toBeLessThan(0.8);
  });

  it('returns [] for empty or irrelevant text', () => {
    expect(parse('')).toEqual([]);
    expect(parse('   \n  ')).toEqual([]);
    expect(parse('Hello world, nothing to see here.')).toEqual([]);
  });

  it('flight numbers: EK 601, QR605, PK 301, UA 863, 9W 123, 6E 2001', () => {
    const legs = parse('EK 601\nQR605\nPK 301\nUA 863\n9W 123\n6E 2001');
    expect(legs.map((l) => l.flightNumber)).toEqual(['EK601', 'QR605', 'PK301', 'UA863', '9W123', '6E2001']);
  });
});

describe('multi-page itineraries', () => {
  const opts = { isKnownIata, referenceDate };
  const page1 = `
E-TICKET ITINERARY RECEIPT   Page 1 of 2
Passenger: KHAN/USMAN MR
Flight EK 601   Economy (Y)   Operated by Emirates
Departure: Mon 12 Oct 2026  02:55   Karachi (KHI)  Terminal 1
Arrival:   Mon 12 Oct 2026  04:20   Dubai (DXB)  Terminal 3
`;
  const page2 = `
E-TICKET ITINERARY RECEIPT   Page 2 of 2
Flight EK 225   Economy (Y)   Operated by Emirates
Departure: Mon 12 Oct 2026  09:55   Dubai (DXB)  Terminal 3
Arrival:   Mon 12 Oct 2026  15:05   San Francisco (SFO)  Terminal I
`;

  it('2-page e-ticket: leg 1 on page 1, leg 2 on page 2', () => {
    const legs = parseItineraryPages([page1, page2], opts);
    expect(legs.map((l) => l.flightNumber)).toEqual(['EK601', 'EK225']);
    expect(legs[0]).toMatchObject({ from: 'KHI', to: 'DXB', depDate: '2026-10-12', depTime: '02:55', arrTime: '04:20' });
    expect(legs[1]).toMatchObject({ from: 'DXB', to: 'SFO', depTime: '09:55', arrTime: '15:05' });
  });

  it('page separators (with date-like file names) are ignored by the parser', () => {
    const text = [
      pageSeparator(1, 'Screenshot 2026-11-30 at 10.31.22 PM.png'),
      page1,
      pageSeparator(2, 'IMG_2031 08:15.jpg'),
      page2,
    ].join('\n');
    expect(pageSeparator(2, 'a\nb---c.png')).toBe('--- Photo 2: a b-c.png ---');
    expect(stripPageSeparators(text)).not.toContain('Screenshot');
    const legs = parseItineraryPages([text], opts);
    expect(legs.map((l) => l.flightNumber)).toEqual(['EK601', 'EK225']);
    expect(legs[0].depDate).toBe('2026-10-12');
    expect(legs[1].depTime).toBe('09:55');
  });

  it('a leg split across the page boundary still parses from the combined text', () => {
    const a = 'Flight EK 225   Economy\nDeparture: Mon 12 Oct 2026  09:55   Dubai (DXB)  Terminal 3\n';
    const b = 'Arrival:   Mon 12 Oct 2026  15:05   San Francisco (SFO)  Terminal I\nBaggage: 2 pieces\n';
    const legs = parseItineraryPages([a, b], opts);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ flightNumber: 'EK225', from: 'DXB', to: 'SFO', depDate: '2026-10-12', depTime: '09:55', arrTime: '15:05' });
    // each half alone is incomplete
    expect(parseItineraryText(a, opts)[0].arrTime).toBeUndefined();
  });

  it('the same leg on two screenshots is deduplicated (text path)', () => {
    const legs = parseItineraryPages([page1, page2, page1], opts);
    expect(legs.map((l) => l.flightNumber)).toEqual(['EK601', 'EK225']);
  });

  it('mergeParsedLegs: same flight + date on two photos keeps the more complete copy and fills gaps', () => {
    const sparse: ParsedLeg = { flightNumber: 'EK601', from: 'KHI', depDate: '2026-10-12', confidence: 0.6, raw: ['EK 601 KHI 12 Oct'] };
    const full: ParsedLeg = {
      flightNumber: 'EK601', from: 'KHI', to: 'DXB', depDate: '2026-10-12', depTime: '02:55', arrDate: '2026-10-12', arrTime: '04:20',
      confidence: 0.95, raw: ['Flight EK 601 02:55 04:20'],
    };
    const other: ParsedLeg = { flightNumber: 'EK225', from: 'DXB', to: 'SFO', depDate: '2026-10-12', depTime: '09:55', arrTime: '15:05', confidence: 0.9, raw: ['EK 225'] };
    for (const input of [[[sparse], [other], [full]], [[full], [other], [sparse]]]) {
      const out = mergeParsedLegs(input);
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({ flightNumber: 'EK601', to: 'DXB', depTime: '02:55', arrTime: '04:20', confidence: 0.95 });
      expect(out[0].raw).toHaveLength(2);
      expect(out[1].flightNumber).toBe('EK225');
    }
    // inputs are not mutated
    expect(sparse.to).toBeUndefined();
    expect(sparse.raw).toHaveLength(1);
  });

  it('mergeParsedLegs: same from/to + departure time dedupes even without (or with a garbled) flight number', () => {
    const a: ParsedLeg = { from: 'KHI', to: 'DXB', depDate: '2026-10-12', depTime: '02:55', confidence: 0.55, raw: ['KHI DXB 02:55'] };
    const b: ParsedLeg = { flightNumber: 'EK601', from: 'KHI', to: 'DXB', depTime: '02:55', arrTime: '04:20', confidence: 0.8, raw: ['EK 601'] };
    const c: ParsedLeg = { flightNumber: 'EK607', from: 'KHI', to: 'DXB', depDate: '2026-10-12', depTime: '02:55', confidence: 0.4, raw: ['EK 6O7'] };
    const out = mergeParsedLegs([[a], [b], [c]]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ flightNumber: 'EK601', from: 'KHI', to: 'DXB', depDate: '2026-10-12', depTime: '02:55', arrTime: '04:20' });
  });

  it('mergeParsedLegs: the same flight number on a different date is a different leg', () => {
    const mk = (d: string): ParsedLeg => ({ flightNumber: 'EK601', from: 'KHI', to: 'DXB', depDate: d, depTime: '02:55', confidence: 0.9, raw: [] });
    expect(mergeParsedLegs([[mk('2026-10-12')], [mk('2026-10-19')]]).map((l) => l.depDate)).toEqual(['2026-10-12', '2026-10-19']);
  });

  it('mergeParsedLegs orders by departure date/time; undated legs keep attachment order', () => {
    const mk = (fn: string, d?: string, t?: string): ParsedLeg => ({ flightNumber: fn, from: 'AAA', depDate: d, depTime: t, confidence: 0.9, raw: [] });
    // photos attached out of order
    const out = mergeParsedLegs([[mk('B2', '2026-10-13', '08:00')], [mk('A1', '2026-10-12', '23:30')], [mk('A0', '2026-10-12', '09:00')]]);
    expect(out.map((l) => l.flightNumber)).toEqual(['A0', 'A1', 'B2']);
    // nothing dated: attachment order
    expect(mergeParsedLegs([[mk('X1')], [mk('X3')], [mk('X2')]]).map((l) => l.flightNumber)).toEqual(['X1', 'X3', 'X2']);
    // an undated leg stays right after its dated predecessor
    expect(
      mergeParsedLegs([[mk('P1', '2026-10-12', '01:00')], [mk('U1')], [mk('P2', '2026-10-13', '01:00')]]).map((l) => l.flightNumber),
    ).toEqual(['P1', 'U1', 'P2']);
    expect(mergeParsedLegs([])).toEqual([]);
  });

  it('three screenshots (leg 1, leg 2, duplicate of leg 1) give exactly two ordered legs', () => {
    const s1 = 'EK 601  Karachi (KHI) Mon 12 Oct 2026 02:55\nArrives Dubai (DXB) 04:20\n';
    const s2 = 'EK 225  Dubai (DXB) Mon 12 Oct 2026 09:55\nArrives San Francisco (SFO) 15:05\n';
    const legs = parseItineraryPages([s2, s1, s1], opts); // attached in the wrong order on purpose
    expect(legs.map((l) => l.flightNumber)).toEqual(['EK601', 'EK225']);
  });
});
