import 'fake-indexeddb/auto';
import { vi } from 'vitest';

// Existing fixtures retain coverage of the enabled feature for restoration.
vi.mock('../core/provider-features.ts', () => ({ CLAUDE_ENABLED: true }));
