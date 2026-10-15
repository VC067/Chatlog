import { sha256Hex } from '../../core/archive/hash.ts';
import type { DeliveryMapping } from '../../core/storage/db.ts';

type Section = NonNullable<DeliveryMapping['notionManagedSections']>[number];
export async function hashManagedFingerprint(value: string): Promise<string> {
  return /^sha256:[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : `sha256:${await sha256Hex(value)}`;
}
async function sanitizeSections(sections: Section[]): Promise<Section[]> {
  return Promise.all(sections.map(async (section) => ({
    id: section.id, marker: section.marker,
    children: await Promise.all(section.children.map(async (child) => ({ id: child.id, fingerprint: await hashManagedFingerprint(child.fingerprint) }))),
  })));
}
// Retain destination pointers and recovery metadata without keeping copies of rich text.
// This is independent of the repository so archive clearing can call it before its transaction.
export async function sanitizeDeliveryMapping(mapping: DeliveryMapping): Promise<DeliveryMapping> {
  const next: DeliveryMapping = {
    id: mapping.id, conversationKey: mapping.conversationKey, destinationId: mapping.destinationId,
    revision: mapping.revision, externalId: mapping.externalId, contentHash: mapping.contentHash,
  };
  if (mapping.notionDataSourceId !== undefined) next.notionDataSourceId = mapping.notionDataSourceId;
  if (mapping.notionManagedSections !== undefined) next.notionManagedSections = await sanitizeSections(mapping.notionManagedSections);
  if (mapping.notionCheckpoint !== undefined) {
    next.notionCheckpoint = mapping.notionCheckpoint ? {
      contentHash: mapping.notionCheckpoint.contentHash, revision: mapping.notionCheckpoint.revision,
      sections: await sanitizeSections(mapping.notionCheckpoint.sections),
      pendingMarker: mapping.notionCheckpoint.pendingMarker, creatingPage: mapping.notionCheckpoint.creatingPage,
    } : null;
  }
  return next;
}
