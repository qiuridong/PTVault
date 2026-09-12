import { StorageAccountSchema, type StorageAccount } from '@ptvault/contracts';
import { z } from 'zod';

import { apiGet } from '../../api/client.js';

const AccountsResponseSchema = z.object({
  accounts: z.array(StorageAccountSchema),
});

export const storageAccountsQueryKey = ['storage', 'accounts'] as const;

export async function getStorageAccounts(): Promise<StorageAccount[]> {
  const response = await apiGet('/api/storage/accounts', AccountsResponseSchema);
  return response.accounts;
}
