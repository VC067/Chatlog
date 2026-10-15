import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ArchivedConversation } from '../contracts/conversation.ts';
import type { DeliveryJob, DestinationRecord, ImportSession } from '../contracts/jobs.ts';

export interface CaptureCheckpoint {
  id: string;
  conversationKey: string;
  cursor: string | null;
  updatedAt: string;
}

export interface DeliveryMapping {
  id: string;
  conversationKey: string;
  destinationId: string;
  revision: number;
  externalId: string | null;
  contentHash: string;
  notionDataSourceId?: string;
  notionManagedSections?: Array<{ id: string; marker: string; children: Array<{ id: string; fingerprint: string }> }>;
  notionCheckpoint?: {
    contentHash: string;
    revision: number;
    sections: Array<{ id: string; marker: string; children: Array<{ id: string; fingerprint: string }> }>;
    pendingMarker: string | null;
    creatingPage: boolean;
  } | null;
}

export interface VaultMetadata {
  key: string;
  value: string;
}

export interface VaultDb extends DBSchema {
  handles: {
    key: string;
    value: FileSystemDirectoryHandle;
  };
  conversations: {
    key: string;
    value: ArchivedConversation;
    indexes: {
      'by-account': [string, string];
    };
  };
  captures: {
    key: string;
    value: CaptureCheckpoint;
  };
  jobs: {
    key: string;
    value: DeliveryJob;
  };
  imports: {
    key: string;
    value: ImportSession;
  };
  destinations: {
    key: string;
    value: DestinationRecord;
  };
  deliveries: {
    key: string;
    value: DeliveryMapping;
    indexes: {
      'by-conversation': string;
    };
  };
  metadata: {
    key: string;
    value: VaultMetadata;
  };
}

export const DB_NAME = 'vaultdraft';
export const DB_VERSION = 2;

function createStores(database: IDBPDatabase<VaultDb>): void {
  if (!database.objectStoreNames.contains('handles')) {
    database.createObjectStore('handles');
  }
  if (!database.objectStoreNames.contains('conversations')) {
    const store = database.createObjectStore('conversations', { keyPath: 'key' });
    store.createIndex('by-account', ['provider', 'accountScope']);
  }
  if (!database.objectStoreNames.contains('captures')) {
    database.createObjectStore('captures', { keyPath: 'id' });
  }
  if (!database.objectStoreNames.contains('jobs')) {
    database.createObjectStore('jobs', { keyPath: 'id' });
  }
  if (!database.objectStoreNames.contains('imports')) {
    database.createObjectStore('imports', { keyPath: 'id' });
  }
  if (!database.objectStoreNames.contains('destinations')) {
    database.createObjectStore('destinations', { keyPath: 'id' });
  }
  if (!database.objectStoreNames.contains('deliveries')) {
    const store = database.createObjectStore('deliveries', { keyPath: 'id' });
    store.createIndex('by-conversation', 'conversationKey');
  }
  if (!database.objectStoreNames.contains('metadata')) {
    database.createObjectStore('metadata', { keyPath: 'key' });
  }
}

export function openVaultDb() {
  return openDB<VaultDb>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      createStores(database);
    },
  });
}
