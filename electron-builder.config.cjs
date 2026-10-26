// electron-builder configuration for the desktop releases.
// Windows: NSIS installer (x64, arm64) and a portable .exe (x64).
// macOS: universal (Apple silicon + Intel) .dmg and .zip, ad-hoc signed.
// Linux: AppImage and .deb for x64, arm64 (Raspberry Pi OS 64-bit, ChromeOS Linux on ARM) and
// armv7l (Raspberry Pi OS 32-bit).
/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'io.github.socrtwo.quillloom',
  productName: 'Anne\'s Loom',
  executableName: 'QuillLoom', // the binary keeps its old name; the product (display) name is Anne's Loom
  copyright: 'Anne\'s Loom contributors, MIT License',
  directories: { app: 'build/desktop-app', output: 'release', buildResources: 'resources' },
  artifactName: 'QuillLoom-${version}-${os}-${arch}.${ext}',
  asar: true,
  // Everything the app needs is bundled into dist/ by Vite; ship no node_modules.
  files: ['dist/**/*', 'electron/**/*', 'package.json', '!**/node_modules/**'],
  icon: 'resources/icon-1024.png',
  // Web files open in Anne's Loom from the file manager (Open With ▸ Anne's Loom on every system).
  fileAssociations: [
    { ext: ['html', 'htm'], name: 'Web Page', role: 'Editor', mimeType: 'text/html' },
    { ext: ['xhtml'], name: 'XHTML Page', role: 'Editor', mimeType: 'application/xhtml+xml' },
    { ext: ['shtml'], name: 'Server-Side Include Page', role: 'Editor', mimeType: 'text/html' },
    { ext: ['css'], name: 'Cascading Style Sheet', role: 'Editor', mimeType: 'text/css' },
    { ext: ['js'], name: 'JavaScript File', role: 'Editor', mimeType: 'text/javascript' },
    { ext: ['php'], name: 'PHP Page', role: 'Editor', mimeType: 'application/x-httpd-php' },
    { ext: ['dwt'], name: 'Dynamic Web Template', role: 'Editor', mimeType: 'text/html' },
    { ext: ['qlsite'], name: 'Anne\'s Loom Site', role: 'Editor', mimeType: 'application/x-quillloom-site' },
    { ext: ['mht', 'mhtml'], name: 'Web Archive', role: 'Viewer', mimeType: 'multipart/related' },
  ],
  win: {
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }, { target: 'portable', arch: ['x64'] }],
  },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, artifactName: 'QuillLoom-${version}-windows-${arch}-setup.${ext}' },
  portable: { artifactName: 'QuillLoom-${version}-windows-portable.${ext}' },
  mac: {
    target: [{ target: 'dmg', arch: ['universal'] }, { target: 'zip', arch: ['universal'] }],
    category: 'public.app-category.developer-tools',
    extendInfo: { CFBundleDisplayName: 'Anne\'s Loom' },
    // Ad-hoc signature: runs on Apple silicon without a paid Developer ID, but is not notarized,
    // so Gatekeeper asks once (docs/INSTALL.md). Hardened runtime would reject Electron's own signature.
    identity: '-',
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64', 'arm64', 'armv7l'] }, { target: 'deb', arch: ['x64', 'arm64', 'armv7l'] }],
    category: 'Development;WebDevelopment',
    synopsis: 'Web site editor with Design, Split and Code views',
    description: 'Anne\'s Loom is an open-source web site editor with Design, Split, Code and Preview views, site-wide link management, Dynamic Web Templates, FTP publishing, AI help, and import from WordPress, Weebly, Wix and web templates. Every feature is a command you can put on the ribbon, the Quick Access Bar, a shortcut or a macro.',
    maintainer: 'socrtwo <socrtwo@users.noreply.github.com>',
    executableName: 'quillloom',
    syncDesktopName: true,
  },
  publish: null,
};
