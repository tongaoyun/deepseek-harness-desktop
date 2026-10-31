/** Record native builder phases without logging configuration or command arguments. */
import { recordPackagingEvent } from '../../desktop/scripts/packaging-run.mjs'
import { packagingStep } from '../../desktop/scripts/packaging-step.mjs'

/**
 * Record assembly time separately from the afterPack verifier and afterSign checks.
 * @param {object} config Native electron-builder configuration.
 * @param {string | undefined} directory Existing private packaging journal.
 * @returns {object} Configuration retaining the original hook results and failures.
 */
export function withBuilderDiagnostics(config, directory) {
  if (directory === undefined) return config
  let assembly
  return { ...config,
    afterExtract: async context => {
      await config.afterExtract?.(context)
      assembly = { started: performance.now(), cpu: process.cpuUsage() }
      recordPackagingEvent(directory, { type: 'builder-assembly-start' })
    },
    afterPack: async context => {
      if (assembly !== undefined) {
        recordPackagingEvent(directory, { type: 'builder-assembly-end', elapsedMs: performance.now() - assembly.started,
          cpu: process.cpuUsage(assembly.cpu), memory: process.memoryUsage(), peakRssKiB: process.resourceUsage().maxRSS })
      }
      return packagingStep(directory, 'builder:after-pack', async () => config.afterPack?.(context))
    },
    afterSign: context => packagingStep(directory, 'builder:after-sign', async () => config.afterSign?.(context)),
  }
}
