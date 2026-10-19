/** Product packaging policy applied through the generic assembly configuration entry. */
import { createElectronBuilderConfig } from '../desktop/scripts/electron-builder-config.mjs'
import { internalBuilderConfig, INTERNAL_APP_ID } from './scripts/internal-package.mjs'

const internal = process.env.PACKAGE_SIGNING === 'internal'
const environment = internal ? { ...process.env, DSH_DESKTOP_APP_ID: INTERNAL_APP_ID } : process.env
const config = createElectronBuilderConfig(environment)
export default internal ? internalBuilderConfig(config, environment, process.platform) : config
