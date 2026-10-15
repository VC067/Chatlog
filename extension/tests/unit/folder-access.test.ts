import { expect, it } from 'vitest';
import { accessFromPermission, pickerWasCancelled } from '../../destinations/markdown/permission.ts';
import { writeTestFile } from '../../destinations/markdown/writer.ts';

it('blocks a write when no folder handle is stored', async () => {
  await expect(writeTestFile()).resolves.toEqual({ status: 'blocked' });
});

it('maps permission states without prompting', () => {
  expect(accessFromPermission(false, null)).toBe('missing');
  expect(accessFromPermission(true, 'granted')).toBe('granted');
  expect(accessFromPermission(true, 'denied')).toBe('denied');
  expect(accessFromPermission(true, 'prompt')).toBe('prompt');
});

it('treats picker cancellation as a non-crash', () => {
  expect(pickerWasCancelled(new DOMException('cancelled', 'AbortError'))).toBe(true);
  expect(pickerWasCancelled(new Error('nope'))).toBe(false);
});
