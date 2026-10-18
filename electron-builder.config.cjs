// electron-builder configuration for the desktop releases.
// Windows: NSIS installer (x64, arm64) and a portable .exe (x64).
// macOS: universal (Apple silicon + Intel) .dmg and .zip, ad-hoc signed.
// Linux: AppImage and .deb for x64, arm64 (Raspberry Pi OS 64-bit, ChromeOS Linux on ARM) and
// armv7l (Raspberry Pi OS 32-bit).
/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'io.github.socrtwo.quillloom',
  productName: 'QuillLoom',
  copyright: 'QuillLoom contributors, MIT License',
  directories: { app: 'build/desktop-app', output: 'release', buildResources: 'resources' },
  artifactName: 'QuillLoom-${version}-${os}-${arch}.${ext}',
  asar: true,
  // Everything the app needs is bundled into dist/ by Vite; ship no node_modules.
  files: ['dist/**/*', 'electron/**/*', 'package.json', '!**/node_modules/**'],
  icon: 'resources/icon-1024.png',
  fileAssociations: [
    { ext: 'pptx', name: 'PowerPoint Presentation', role: 'Editor', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
    { ext: 'pptm', name: 'PowerPoint Macro-Enabled Presentation', role: 'Editor', mimeType: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12' },
    { ext: 'ppsx', name: 'PowerPoint Show', role: 'Editor', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow' },
    { ext: 'potx', name: 'PowerPoint Template', role: 'Editor', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.template' },
    { ext: 'ppt', name: 'PowerPoint 97-2003 Presentation', role: 'Viewer', mimeType: 'application/vnd.ms-powerpoint' },
    { ext: 'odp', name: 'OpenDocument Presentation', role: 'Editor', mimeType: 'application/vnd.oasis.opendocument.presentation' },
    { ext: 'fodp', name: 'Flat OpenDocument Presentation', role: 'Editor', mimeType: 'application/vnd.oasis.opendocument.flat-presentation' },
    { ext: 'md', name: 'Markdown Slides', role: 'Editor', mimeType: 'text/markdown' },
    { ext: 'qsp', name: 'QuillLoom Presentation', role: 'Editor', mimeType: 'application/x-quillloom' },
    { ext: 'qspe', name: 'Encrypted QuillLoom Presentation', role: 'Editor', mimeType: 'application/x-quillloom-encrypted' },
  ],
  win: {
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }, { target: 'portable', arch: ['x64'] }],
  },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, artifactName: 'QuillLoom-${version}-windows-${arch}-setup.${ext}' },
  portable: { artifactName: 'QuillLoom-${version}-windows-portable.${ext}' },
  mac: {
    target: [{ target: 'dmg', arch: ['universal'] }, { target: 'zip', arch: ['universal'] }],
    category: 'public.app-category.productivity',
    extendInfo: { CFBundleDisplayName: 'QuillLoom' },
    // Ad-hoc signature: runs on Apple silicon without a paid Developer ID, but is not notarized,
    // so Gatekeeper asks once (docs/INSTALL.md). Hardened runtime would reject Electron's own signature.
    identity: '-',
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64', 'arm64', 'armv7l'] }, { target: 'deb', arch: ['x64', 'arm64', 'armv7l'] }],
    category: 'Office;Presentation',
    synopsis: 'Presentation app with a complete, customizable command library',
    description: 'QuillLoom is an open-source presentation app that opens and saves PowerPoint (.pptx), OpenDocument (.odp) and Markdown slides. Every feature is a command you can put on the ribbon, the Quick Access Bar, a shortcut or a macro.',
    maintainer: 'socrtwo <socrtwo@users.noreply.github.com>',
    executableName: 'quillloom',
    syncDesktopName: true,
  },
  publish: null,
};
