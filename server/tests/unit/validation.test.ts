import { describe, expect, it } from 'vitest';
import { ageOn, capitalizeName, emiratesIdProblem, formatEmiratesId, luhnValid, normalizePhone, requiresEmiratesId } from '../../../shared/validation';
import { COUNTRY_CODES, isCountryCode, nationalityName } from '../../../shared/countries';

describe('Emirates ID', () => {
  it('accepts valid numbers with or without dashes', () => {
    expect(emiratesIdProblem('784-1990-1234567-6')).toBeNull();
    expect(emiratesIdProblem('784199012345676')).toBeNull();
    expect(emiratesIdProblem('784 1985 7654321 3')).toBeNull();
  });
  it('rejects a wrong check digit', () => {
    expect(emiratesIdProblem('784-1990-1234567-1')).toBe('validation.emiratesIdChecksum');
  });
  it('rejects the wrong length, prefix or birth year', () => {
    expect(emiratesIdProblem('784-1990-123456-6')).toBe('validation.emiratesIdFormat');
    expect(emiratesIdProblem('785-1990-1234567-6')).toBe('validation.emiratesIdFormat');
    expect(emiratesIdProblem('784-1700-1234567-6')).toBe('validation.emiratesIdFormat');
  });
  it('formats to 784-YYYY-NNNNNNN-C', () => {
    expect(formatEmiratesId('784199012345676')).toBe('784-1990-1234567-6');
  });
  it('applies to the Emirates ID type, or to UAE nationals when no type is given', () => {
    expect(requiresEmiratesId('EMIRATES_ID', 'IN')).toBe(true);
    expect(requiresEmiratesId(null, 'AE')).toBe(true);
    expect(requiresEmiratesId('PASSPORT', 'AE')).toBe(false);
    expect(requiresEmiratesId(null, 'JO')).toBe(false);
  });
  it('implements Luhn', () => {
    expect(luhnValid('79927398713')).toBe(true);
    expect(luhnValid('79927398710')).toBe(false);
  });
});

describe('phone numbers', () => {
  it('normalises UAE numbers to E.164 with AE as the default region', () => {
    expect(normalizePhone('050 123 4567')).toBe('+971501234567');
    expect(normalizePhone('+971 4 123 4567')).toBe('+97141234567');
    expect(normalizePhone('00971501234567')).toBe('+971501234567');
  });
  it('keeps foreign numbers in international format', () => {
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
  });
  it('rejects invalid numbers', () => {
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('call me')).toBeNull();
  });
});

describe('name capitalisation', () => {
  it('title-cases names typed in one case', () => {
    expect(capitalizeName('OMAR AL MANSOORI')).toBe('Omar Al Mansoori');
    expect(capitalizeName('fatima al zaabi')).toBe('Fatima Al Zaabi');
  });
  it('keeps "bin" and similar particles lower-case', () => {
    expect(capitalizeName('saeed bin rashid')).toBe('Saeed bin Rashid');
    expect(capitalizeName('MARIAM BINT KHALID')).toBe('Mariam bint Khalid');
    expect(capitalizeName('bin rashid al maktoum')).toBe('bin Rashid Al Maktoum');
    expect(capitalizeName('LI BIN')).toBe('Li Bin');
  });
  it('handles hyphens and apostrophes', () => {
    expect(capitalizeName('al-mansoori')).toBe('Al-Mansoori');
    expect(capitalizeName("o'neil")).toBe("O'Neil");
  });
  it('leaves deliberately mixed-case and Arabic names untouched', () => {
    expect(capitalizeName('McDonald')).toBe('McDonald');
    expect(capitalizeName('Al Mansoori')).toBe('Al Mansoori');
    expect(capitalizeName('عمر المنصوري')).toBe('عمر المنصوري');
  });
  it('collapses extra spaces', () => {
    expect(capitalizeName('  james   carter ')).toBe('James Carter');
  });
});

describe('dates and countries', () => {
  it('computes age in whole years', () => {
    expect(ageOn('2008-06-15', '2026-06-14')).toBe(17);
    expect(ageOn('2008-06-15', '2026-06-15')).toBe(18);
  });
  it('covers the ISO 3166-1 list and shows nationality names', () => {
    expect(COUNTRY_CODES.length).toBeGreaterThanOrEqual(249);
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
    expect(isCountryCode('jo')).toBe(true);
    expect(isCountryCode('XX')).toBe(false);
    expect(nationalityName('JO')).toBe('Jordanian');
    expect(nationalityName('JO', 'ar')).toBe('أردني');
    expect(nationalityName('AE')).toBe('Emirati');
  });
});
