import { z } from 'zod';

export const settingsSchema = z.object({
  markdownEnabled: z.boolean().default(true),
  autoSync: z.boolean().default(true),
  syncIntervalMinutes: z.number().int().min(15).max(24 * 60).default(120),
  saveCreatedFiles: z.boolean().default(true),
  saveUploadedFiles: z.boolean().default(true),
  includeSources: z.boolean().default(false),
  saveClaudeProjects: z.boolean().default(true),
  saveCodeGallery: z.boolean().default(true),
  saveCowork: z.boolean().default(false),
  latestSaveCount: z.number().int().min(1).max(500).default(5),
  folderDiskPath: z.string().max(500).default(''),
  theme: z.enum(['system', 'light', 'dark']).default('light'),
  onboardingComplete: z.boolean().default(false),
});

export type Settings = z.infer<typeof settingsSchema>;

const SETTINGS_KEY = 'settings';

export async function readSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  const raw = stored[SETTINGS_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return settingsSchema.parse({});
  const recovered: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(settingsSchema.shape)) {
    const value = (raw as Record<string, unknown>)[key];
    const parsed = field.safeParse(value);
    if (parsed.success) recovered[key] = parsed.data;
    else if (key === 'autoSync') recovered[key] = false;
  }
  return settingsSchema.parse(recovered);
}

export async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const validated = settingsSchema.partial().strict().parse(patch);
  const next = settingsSchema.parse({ ...(await readSettings()), ...validated });
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}
