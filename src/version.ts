/**
 * Single source of truth for the plugin version reported on the probe frame.
 *
 * This is the Multica runtime plugin's own version, not a DSH package version:
 * it tracks the DSH release channel this build was validated against, so the
 * daemon can tell which channel a profile is running. Keep it in step with the
 * `version` field in package.json.
 */
export const PLUGIN_VERSION = '0.1.0-rc.2'
