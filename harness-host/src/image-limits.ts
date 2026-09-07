export const IMAGE_LIMITS = {
  maxImageBytes: 10 * 1024 * 1024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 40 * 1024 * 1024,
  maxImagePixels: 4_000_000,
  maxImageDimension: 2560,
  mediaTypes: ['image/png', 'image/jpeg'] as Array<'image/png' | 'image/jpeg'>,
}
