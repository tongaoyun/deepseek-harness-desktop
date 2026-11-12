/** Shared metadata validation for trash entries and successful restore receipts. */
import { z } from 'zod'

/** Persisted version, source identity and exact filenames required before accepting a trash record. */
export const trashMetadataSchema = z.object({
  version: z.literal(2), id: z.string(), name: z.string(), deletedAt: z.iso.datetime(),
  entries: z.array(z.string()).min(1).max(2),
  repository: z.object({ id: z.string().min(1), path: z.string() }).optional(),
  catalog: z.array(z.string().min(1)).optional(),
  root: z.object({ key: z.string(), scope: z.string(), label: z.string(), localeKey: z.string().optional(),
    projectRoot: z.string().optional(), projectName: z.string().optional(), kind: z.string().optional() }),
})
