// @ts-check

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  APP_NAME,
  getBridgeDir,
  getLauncherFilename,
  getManifestInstallDir,
  PUBLISHED_EXTENSION_ID,
} from './config.js';

/**
 * Per-browser registry parent path for Windows native messaging host
 * registration. Chrome (and every Chromium fork) requires the manifest to be
 * announced via a registry key whose default value points at the JSON file;
 * the file alone is not discovered on Windows.
 *
 * @type {Record<import('./config.js').SupportedBrowser, string>}
 */
const WIN32_REGISTRY_BASES = {
  chrome: 'Software\\Google\\Chrome',
  edge: 'Software\\Microsoft\\Edge',
  brave: 'Software\\BraveSoftware\\Brave-Browser',
  chromium: 'Software\\Chromium',
  arc: 'Software\\Arc',
};

/**
 * Build the per-browser HKCU registry key path that Chromium native messaging
 * uses to discover a host on Windows.
 *
 * @param {import('./config.js').SupportedBrowser} browser
 * @returns {string}
 */
export function getNativeMessagingRegistryKey(browser) {
  const base = WIN32_REGISTRY_BASES[browser] ?? WIN32_REGISTRY_BASES.chrome;
  return `HKCU\\${base}\\NativeMessagingHosts\\${APP_NAME}`;
}

/**
 * Spawn `reg.exe` and resolve when it exits successfully. Used instead of a
 * native dependency so the install path stays dependency-free.
 *
 * @param {string[]} args
 * @returns {Promise<void>}
 */
function runReg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('reg.exe', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`reg.exe ${args[0]} failed (exit ${code}): ${stderr.trim()}`));
      }
    });
  });
}

/**
 * Register the native messaging host with Chromium on Windows by setting the
 * default value of the per-browser host key to the manifest path. No-op on
 * non-Windows platforms.
 *
 * @param {import('./config.js').SupportedBrowser} browser
 * @param {string} manifestPath
 * @returns {Promise<{ key: string } | null>}
 */
export async function registerWindowsNativeHost(browser, manifestPath) {
  if (process.platform !== 'win32') {
    return null;
  }
  const key = getNativeMessagingRegistryKey(browser);
  await runReg(['ADD', key, '/ve', '/d', manifestPath, '/f']);
  return { key };
}

/**
 * Remove the Windows native messaging registry entry for one browser. No-op
 * on non-Windows platforms or when the key does not exist.
 *
 * @param {import('./config.js').SupportedBrowser} browser
 * @returns {Promise<{ key: string, removed: boolean } | null>}
 */
export async function unregisterWindowsNativeHost(browser) {
  if (process.platform !== 'win32') {
    return null;
  }
  const key = getNativeMessagingRegistryKey(browser);
  try {
    await runReg(['DELETE', key, '/f']);
    return { key, removed: true };
  } catch (error) {
    // reg DELETE on a missing key returns a non-zero exit code; surface as a
    // soft no-op rather than a hard failure so uninstall stays idempotent.
    const message = error instanceof Error ? error.message : String(error);
    if (/cannot find|unable to find|not exist/iu.test(message)) {
      return { key, removed: false };
    }
    throw error;
  }
}

export const DEFAULT_EXTENSION_ID_ENV = 'BROWSER_BRIDGE_EXTENSION_ID';
export const BUILT_IN_EXTENSION_ID_SOURCE = 'built_in';

/** @typedef {import('./config.js').SupportedBrowser} SupportedBrowser */
/** @typedef {'env' | 'built_in' | 'none' | 'invalid_env'} ExtensionIdSource */

/**
 * @typedef {{
 *   repoRoot: string,
 *   extensionIdArg?: string | undefined,
 *   browser?: SupportedBrowser | undefined,
 *   nodePath?: string | undefined,
 *   installDir?: string | undefined,
 *   bridgeDir?: string | undefined,
 *   stdout?: Pick<NodeJS.WriteStream, 'write'>,
 *   stderr?: Pick<NodeJS.WriteStream, 'write'>,
 *   preserveCustomExtensionId?: boolean | undefined,
 *   env?: NodeJS.ProcessEnv
 * }} InstallManifestOptions
 */

/**
 * @typedef {{
 *   browser?: SupportedBrowser | undefined,
 *   installDir?: string | undefined,
 *   bridgeDir?: string | undefined,
 *   removeBridgeDir?: boolean | undefined,
 *   stdout?: Pick<NodeJS.WriteStream, 'write'>
 * }} UninstallManifestOptions
 */

/**
 * Parse and validate a Chrome extension ID from a CLI argument.
 * Accepts a raw 32-char ID or a full `chrome-extension://<id>/` origin.
 *
 * @param {string | undefined} arg
 * @returns {string | null}
 */
export function parseExtensionId(arg) {
  if (!arg) return null;

  const originMatch = arg.match(/^chrome-extension:\/\/([a-z]{32})\/?$/);
  if (originMatch) return originMatch[1];

  if (/^[a-z]{32}$/.test(arg)) return arg;
  return null;
}

/**
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {{ extensionId: string | null, source: ExtensionIdSource }}
 */
export function resolveDefaultExtensionId(env = process.env) {
  const candidate = env[DEFAULT_EXTENSION_ID_ENV];
  if (candidate !== undefined) {
    const parsed = parseExtensionId(candidate);
    return {
      extensionId: parsed,
      source: parsed ? 'env' : 'invalid_env',
    };
  }

  return {
    extensionId: PUBLISHED_EXTENSION_ID || null,
    source: PUBLISHED_EXTENSION_ID ? 'built_in' : 'none',
  };
}

/**
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string | null}
 */
export function getDefaultExtensionId(env = process.env) {
  return resolveDefaultExtensionId(env).extensionId;
}

/**
 * Build the allowed_origins list.
 * If an extension ID was provided, ensures its origin is present.
 * Otherwise falls back to existing origins or a placeholder.
 *
 * @param {{allowed_origins?: string[]} | null} existingManifest
 * @param {string | null} extensionId
 * @returns {string[]}
 */
export function getAllowedOrigins(existingManifest, extensionId) {
  const existing =
    existingManifest && Array.isArray(existingManifest.allowed_origins)
      ? existingManifest.allowed_origins
      : [];

  if (extensionId) {
    const origin = `chrome-extension://${extensionId}/`;
    const merged = new Set(existing);
    merged.add(origin);
    for (const item of [...merged]) {
      if (item.includes('__REPLACE_WITH_EXTENSION_ID__')) {
        merged.delete(item);
      }
    }
    return [...merged];
  }

  if (existing.length > 0) return existing;
  return ['chrome-extension://__REPLACE_WITH_EXTENSION_ID__/'];
}

/**
 * @param {string[] | undefined} allowedOrigins
 * @returns {string[]}
 */
function getExtensionIdsFromAllowedOrigins(allowedOrigins) {
  if (!Array.isArray(allowedOrigins)) {
    return [];
  }

  const ids = new Set();
  for (const origin of allowedOrigins) {
    const match = /^chrome-extension:\/\/([a-z]{32})\/?$/.exec(origin);
    if (match?.[1]) {
      ids.add(match[1]);
    }
  }
  return [...ids];
}

/**
 * @param {string} value
 * @returns {string}
 */
export function escapeSingleQuotes(value) {
  return value.replaceAll("'", "'\\''");
}

/**
 * @param {string} filePath
 * @returns {Promise<{allowed_origins?: string[]} | null>}
 */
export async function readExistingManifest(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {InstallManifestOptions} options
 * @returns {Promise<{ manifestPath: string, launcherPath: string, allowedOrigins: string[], extensionId: string | null }>}
 */
export async function installNativeManifest(options) {
  const {
    repoRoot,
    extensionIdArg,
    browser,
    nodePath = process.execPath,
    installDir = getManifestInstallDir(browser),
    bridgeDir = getBridgeDir(),
    stdout = process.stdout,
    stderr = process.stderr,
    preserveCustomExtensionId = false,
    env = process.env,
  } = options;

  const parsedExtensionId = parseExtensionId(extensionIdArg);
  if (extensionIdArg && !parsedExtensionId) {
    throw new Error(
      `Invalid extension ID: ${extensionIdArg}\nExpected 32 lowercase letters or chrome-extension://<id>/`
    );
  }

  const defaultExtensionId = resolveDefaultExtensionId(env);
  if (!parsedExtensionId && defaultExtensionId.source === 'invalid_env') {
    throw new Error(
      `Invalid ${DEFAULT_EXTENSION_ID_ENV}: ${env[DEFAULT_EXTENSION_ID_ENV]}\nExpected 32 lowercase letters or chrome-extension://<id>/`
    );
  }
  const requestedExtensionId = parsedExtensionId || defaultExtensionId.extensionId;
  const hostPath = path.join(repoRoot, 'packages', 'native-host', 'bin', 'native-host.js');
  const launcherPath = path.join(bridgeDir, getLauncherFilename());
  const manifestPath = path.join(installDir, `${APP_NAME}.json`);

  const launcher =
    process.platform === 'win32'
      ? `@echo off\r\n"${nodePath}" "${hostPath}" %*\r\n`
      : `#!/bin/sh
exec '${escapeSingleQuotes(nodePath)}' '${escapeSingleQuotes(hostPath)}' "$@"
`;

  const existingManifest = await readExistingManifest(manifestPath);
  const existingExtensionIds = getExtensionIdsFromAllowedOrigins(existingManifest?.allowed_origins);
  const hasStoreOrigin = existingExtensionIds.includes(PUBLISHED_EXTENSION_ID);
  const customExtensionIds = existingExtensionIds.filter((id) => id !== PUBLISHED_EXTENSION_ID);
  const preservedCustomExtensionId =
    preserveCustomExtensionId &&
    !parsedExtensionId &&
    extensionIdArg == null &&
    defaultExtensionId.source === BUILT_IN_EXTENSION_ID_SOURCE &&
    customExtensionIds.length > 0 &&
    !hasStoreOrigin;
  const allowedOrigins = preservedCustomExtensionId
    ? getAllowedOrigins(existingManifest, null)
    : getAllowedOrigins(existingManifest, requestedExtensionId);
  const extensionId = preservedCustomExtensionId
    ? customExtensionIds[0] || requestedExtensionId
    : requestedExtensionId;

  /** @type {{name: string, description: string, path: string, type: 'stdio', allowed_origins: string[]}} */
  const manifest = {
    name: APP_NAME,
    description: 'Browser Bridge native host',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: allowedOrigins,
  };

  await fs.promises.mkdir(installDir, { recursive: true });
  await fs.promises.mkdir(bridgeDir, { recursive: true });
  await fs.promises.writeFile(launcherPath, launcher, 'utf8');
  if (process.platform !== 'win32') {
    await fs.promises.chmod(launcherPath, 0o755);
  }
  await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  stdout.write(`Wrote ${manifestPath}\n`);
  stdout.write(`Wrote ${launcherPath}\n`);

  if (process.platform === 'win32') {
    try {
      const registration = await registerWindowsNativeHost(browser ?? 'chrome', manifestPath);
      if (registration) {
        stdout.write(`Registered ${registration.key}\n`);
      }
    } catch (error) {
      stderr.write(
        `Warning: could not register native host in the Windows registry. ` +
          `Chromium reads native messaging hosts from the registry on Windows; the manifest file alone is not discovered. ` +
          `Underlying error: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }

  if (!preservedCustomExtensionId && !parsedExtensionId && extensionIdArg == null && extensionId) {
    if (defaultExtensionId.source === 'env') {
      stdout.write(`Used extension ID from ${DEFAULT_EXTENSION_ID_ENV}.\n`);
    } else if (defaultExtensionId.source === BUILT_IN_EXTENSION_ID_SOURCE) {
      stdout.write('Used built-in Browser Bridge extension ID.\n');
    }
  }

  if (preservedCustomExtensionId) {
    stderr.write(
      `Warning: existing native host manifest keeps custom extension ID ${customExtensionIds.join(', ')} instead of the Browser Bridge store ID ${PUBLISHED_EXTENSION_ID}. Leaving allowed_origins unchanged.\n`
    );
  }

  const hasPlaceholder = allowedOrigins.some((origin) =>
    origin.includes('__REPLACE_WITH_EXTENSION_ID__')
  );
  if (hasPlaceholder) {
    stdout.write(
      'Tip: pass the extension ID to set allowed_origins automatically:\n' +
        '  bbx install <extension-id>\n'
    );
  }

  return {
    manifestPath,
    launcherPath,
    allowedOrigins,
    extensionId,
  };
}

/**
 * @param {UninstallManifestOptions} [options={}]
 * @returns {Promise<{ manifestPath: string, bridgeDir: string, removedManifest: boolean, removedBridgeDir: boolean }>}
 */
export async function uninstallNativeManifest(options = {}) {
  const {
    browser,
    installDir = getManifestInstallDir(browser),
    bridgeDir = getBridgeDir(),
    removeBridgeDir = false,
    stdout = process.stdout,
  } = options;

  const manifestPath = path.join(installDir, `${APP_NAME}.json`);
  const removedManifest = await removePathIfExists(manifestPath);
  if (removedManifest) {
    stdout.write(`Removed ${manifestPath}\n`);
  }

  if (process.platform === 'win32') {
    try {
      const result = await unregisterWindowsNativeHost(browser ?? 'chrome');
      if (result?.removed) {
        stdout.write(`Removed registry key ${result.key}\n`);
      }
    } catch {
      // Registry cleanup is best-effort: a stray key cannot prevent
      // reinstall, so do not surface an error from uninstall.
    }
  }

  const removedBridgeDir = removeBridgeDir ? await removePathIfExists(bridgeDir) : false;
  if (removedBridgeDir) {
    stdout.write(`Removed ${bridgeDir}\n`);
  }

  return {
    manifestPath,
    bridgeDir,
    removedManifest,
    removedBridgeDir,
  };
}

/**
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
async function removePathIfExists(targetPath) {
  try {
    await fs.promises.access(targetPath);
  } catch {
    return false;
  }

  try {
    await fs.promises.rm(targetPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    const code = /** @type {{ code?: string } | undefined} */ (error)?.code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
