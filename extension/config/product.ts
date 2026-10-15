export const product = {
  permissions: ['storage', 'scripting', 'alarms', 'activeTab'] as const,
  providers: ['chatgpt', 'claude', 'grok'] as const,
  singlePurpose:
    'Capture and archive AI conversations into local Markdown or Notion.',
  billing: {
    launchPriceUsd: 49,
    standardPriceUsd: 79,
    launchPurchases: 50,
    personalInstallations: 5,
    refundDays: 14,
    // Public purchase configuration is filled in after branding; never bundle merchant secrets.
    checkoutUrl: null as string | null,
    businessId: null as string | null,
    productIds: [] as string[],
  },
} as const;
