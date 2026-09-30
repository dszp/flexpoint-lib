import { describe, it, expect } from 'vitest';
import { parseFlexPointJson, quoteIdIntegers, FlexPointPrecisionError, isIdKey } from './json.js';

describe('parseFlexPointJson', () => {
  it('keeps an int64 id exact where JSON.parse rounds it', () => {
    const text = '[{"payoutId":900000000000000123,"amount":12.5}]';
    expect(String((JSON.parse(text) as any)[0].payoutId)).not.toBe('900000000000000123');
    expect(parseFlexPointJson(text)).toEqual([{ payoutId: '900000000000000123', amount: 12.5 }]);
  });

  it('turns every id into a string, small or large, so the type never depends on the value', () => {
    expect(parseFlexPointJson('{"customerId":42,"contactId":900000000000000456}')).toEqual({
      customerId: '42',
      contactId: '900000000000000456',
    });
  });

  it('leaves non-id numbers, including decimals and exponents, as numbers', () => {
    expect(parseFlexPointJson('{"qty":3,"unitPrice":-1.5e2,"lineItemsCount":0}')).toEqual({
      qty: 3,
      unitPrice: -150,
      lineItemsCount: 0,
    });
  });

  it('never rewrites digits inside strings, including escaped quotes and id-looking keys in values', () => {
    const text = '{"customerMessage":"ref \\"x\\" \\"payoutId\\":900000000000000123","invoiceId":1}';
    expect(parseFlexPointJson(text)).toEqual({
      customerMessage: 'ref "x" "payoutId":900000000000000123',
      invoiceId: '1',
    });
  });

  it('handles nesting: ids inside nested objects and arrays of ids', () => {
    const text = '{"invoice":{"invoiceId":900000000000000789},"lineItems":[{"invoiceItemId":900000000000000790}],"relatedIds":[1,900000000000000789]}';
    expect(parseFlexPointJson(text)).toEqual({
      invoice: { invoiceId: '900000000000000789' },
      lineItems: [{ invoiceItemId: '900000000000000790' }],
      relatedIds: ['1', '900000000000000789'],
    });
  });

  it('does not leak an id key onto the next numeric sibling', () => {
    expect(parseFlexPointJson('{"payoutId":5, "amount":7}')).toEqual({ payoutId: '5', amount: 7 });
  });

  it('throws rather than round an unsafe integer under a non-id key', () => {
    expect(() => parseFlexPointJson('{"amount":900000000000000123}')).toThrow(FlexPointPrecisionError);
  });

  it('returns undefined for an empty body and preserves whitespace-insensitive parsing', () => {
    expect(parseFlexPointJson('')).toBeUndefined();
    expect(parseFlexPointJson(' { "payoutId" : 7 } ')).toEqual({ payoutId: '7' });
  });

  it('quoteIdIntegers is a pure text transform', () => {
    expect(quoteIdIntegers('{"id":1,"n":2}')).toBe('{"id":"1","n":2}');
  });

  it('recognises id-shaped keys', () => {
    for (const k of ['id', 'ID', 'payoutId', 'invoice_item_id', 'customerID', 'relatedIds', 'ids']) expect(isIdKey(k), k).toBe(true);
    for (const k of ['paid', 'idle', 'amount', undefined]) expect(isIdKey(k), String(k)).toBe(false);
  });
});
