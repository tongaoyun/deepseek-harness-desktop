/** File-library wire values contain no storage paths, URLs or credentials. */
import { z } from 'zod'
const id = z.uuid()
const timestamp = z.iso.datetime({ offset: true })
/** Limits for one library-file selection admitted into the native composer. */
export const LIBRARY_ATTACHMENT_LIMITS = { files: 20, bytes: 100 * 1024 * 1024 } as const
/** Authorized library metadata returned by the server. */
export const LibrarySchema = z
  .object({
    id,
    name: z.string().min(1).max(180),
    description: z.string().max(1000),
    scope: z.enum(['PERSONAL', 'DEPARTMENT', 'COMPANY']),
    ownerId: z.string().min(1),
    managerEmployeeId: z.string().min(1),
    canManage: z.boolean(),
    version: z.number().int().positive(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .readonly()
/** A personal, department or company file library. */
export type Library = z.infer<typeof LibrarySchema>
/** File or folder metadata; file bytes are transferred separately. */
export const LibraryEntrySchema = z
  .object({
    id,
    libraryId: id,
    parentId: id.nullable(),
    name: z.string().min(1).max(180),
    kind: z.enum(['FILE', 'FOLDER']),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    mediaType: z.string().min(3).max(120).nullable(),
    sizeBytes: z.number().int().nonnegative(),
    favorite: z.boolean(),
    version: z.number().int().positive(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .refine(value =>
    value.kind === 'FILE'
      ? value.sha256 !== null && value.mediaType !== null && value.sizeBytes > 0
      : value.sha256 === null && value.mediaType === null && value.sizeBytes === 0,
  )
  .readonly()
/** A versioned file or folder in a library. */
export type LibraryEntry = z.infer<typeof LibraryEntrySchema>
/** Bounded server page of authorized libraries. */
export const LibraryPageSchema = z.object({
  data: z.array(LibrarySchema).readonly(),
  pageIndex: z.number().int().positive(),
  pageSize: z.number().int().positive().max(100),
  totalCount: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
})
/** Bounded server page of files and folders. */
export const LibraryEntryPageSchema = LibraryPageSchema.extend({ data: z.array(LibraryEntrySchema).readonly() })
/** A validated entry page. */
export type LibraryEntryPage = z.infer<typeof LibraryEntryPageSchema>
/** Main-owned handle for a file selected with the native picker. */
export const LibrarySelectionSchema = z
  .object({ selectionId: id, name: z.string().min(1), sizeBytes: z.number().int().positive() })
  .readonly()
/** Selected upload metadata without exposing a local path. */
export type LibrarySelection = z.infer<typeof LibrarySelectionSchema>
/** Resource identity accepted at the product IPC boundary. */
export const LibraryIdentitySchema = z.object({ libraryId: id, entryId: id }).strict()

/** Cross-library file row; source sessions remain subject to native session access. */
export const LibraryFileSchema = z.object({
  entry: LibraryEntrySchema.refine(value => value.kind === 'FILE'),
  libraryName: z.string().min(1).max(180),
  canManage: z.boolean(),
  lastAccessedAt: timestamp.nullable(),
  sourceKind: z.enum(['UPLOAD', 'CONVERSATION']),
  sourceSessionId: z.string().min(1).max(180).nullable(),
}).readonly()
/** Employee-authorized global file projection. */
export type LibraryFile = z.infer<typeof LibraryFileSchema>
/** Filters applied before server pagination. */
export const LibraryFileQuerySchema = z.object({
  query: z.string().max(180).default(''),
  view: z.enum(['recent', 'mine', 'favorites']).default('recent'),
  category: z.enum(['all', 'document', 'media', 'html', 'other']).default('all'),
  sort: z.enum(['accessed', 'name', 'size', 'updated']).default('accessed'),
  direction: z.enum(['asc', 'desc']).default('desc'),
})
/** Global file page without storage addresses. */
export const LibraryFilePageSchema = LibraryPageSchema.extend({ data: z.array(LibraryFileSchema).readonly() })
