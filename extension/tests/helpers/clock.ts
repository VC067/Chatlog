export function createClock(startIso: string) {
  let current = new Date(startIso).getTime();

  return {
    now(): string {
      return new Date(current).toISOString();
    },
    advance(milliseconds: number): void {
      current += milliseconds;
    },
  };
}
