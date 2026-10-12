import { describe, it, expect } from 'vitest';
import { parseItineraryText, type ParsedLeg } from '../src/ocr/parseItinerary';
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
