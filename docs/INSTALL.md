# Installing QuillLoom

Every release on the [Releases](https://github.com/socrtwo/QuillLoom/releases) page has a build for each supported platform, plus `SHA256SUMS.txt` to check the downloads. The builds are not signed with paid certificates, so each system asks once whether to trust them. The steps are below.

| Platform | File | Notes |
|---|---|---|
| Windows 10/11 (x64) | `QuillLoom-<v>-windows-x64-setup.exe` | Installer; per-user, no admin rights needed |
| Windows on ARM | `QuillLoom-<v>-windows-arm64-setup.exe` | |
| Windows, no install | `QuillLoom-<v>-windows-portable.exe` | Runs from a USB stick or any folder |
| macOS 11+ | `QuillLoom-<v>-mac-universal.dmg` (or `.zip`) | One app for Apple silicon and Intel |
| Linux x64 | `QuillLoom-<v>-linux-x86_64.AppImage` or `QuillLoom-<v>-linux-amd64.deb` | |
| Raspberry Pi OS 64-bit (Pi 3/4/5) | `QuillLoom-<v>-linux-arm64.deb` or `QuillLoom-<v>-linux-arm64.AppImage` | |
| Raspberry Pi OS 32-bit | `QuillLoom-<v>-linux-armv7l.deb` | Pi 2 and later. A Pi 4 or 5 runs it much faster. |
| ChromeOS | Linux `.deb`, or the web app | See below |
| Android, iOS / iPadOS | the web app | No native package yet; see below |
| Web | `QuillLoom-<v>-web.zip` | Static files for any web server |

## Windows

Run the setup file. SmartScreen may say "Windows protected your PC": choose **More info ▸ Run anyway**. The warning appears because the installer is not signed with a paid code-signing certificate. Web pages (.html, .htm, .xhtml, .shtml), style sheets (.css), scripts (.js), PHP pages, Dynamic Web Templates (.dwt), QuillLoom sites (.qlsite) and web archives (.mht, .mhtml) get **Open with ▸ QuillLoom**.

## macOS

Open the `.dmg` and drag QuillLoom to Applications. The app has an ad-hoc signature but is not notarized by Apple. So the first time, **right-click (or Control-click) the app ▸ Open ▸ Open**. On macOS 15 and later, you may instead need to go to **System Settings ▸ Privacy & Security ▸ Open Anyway** after the first attempt. If macOS reports the app as "damaged", run this once in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/QuillLoom.app
```

## Linux and Raspberry Pi OS

`.deb` (Debian, Ubuntu, Mint, Raspberry Pi OS):

```bash
sudo apt install ./QuillLoom-<v>-linux-arm64.deb     # or -amd64 / -armv7l
```

QuillLoom then appears in the Development (Programming) menu, and web files offer **Open With ▸ QuillLoom**. To remove it: `sudo apt remove quillloom`.

AppImage (any distribution, no install):

```bash
chmod +x QuillLoom-<v>-linux-x86_64.AppImage
./QuillLoom-<v>-linux-x86_64.AppImage
```

Some distributions need `libfuse2` (`sudo apt install libfuse2`) for AppImages. On Ubuntu 24.04 and later, AppImages may also need `--no-sandbox` because of an AppArmor restriction. The `.deb` does not have that problem.

## ChromeOS

Pick one:

1. **Linux app**: turn on **Settings ▸ Advanced ▸ Developers ▸ Linux development environment**. Then double-click the `.deb` in the Files app: use `amd64` on Intel/AMD Chromebooks and `arm64` on ARM Chromebooks. This is the full desktop app, with site folders and FTP publishing.
2. **Web app**: open a hosted copy of QuillLoom in Chrome, then **⋮ ▸ Cast, save and share ▸ Install page as app**. It then works offline and opens web pages and site archives from the Files app.

## Android, iPhone and iPad

There is no Android or iOS package yet. Open a hosted copy of QuillLoom in the browser and install it: on Android, Chrome's **⋮ ▸ Add to Home screen ▸ Install**; on iOS and iPadOS, Safari's **Share ▸ Add to Home Screen**. The web app works offline after the first visit. It opens and saves single files, ZIP archives and `.qlsite` sites. Site folders and FTP publishing need the desktop app, or a desktop browser with folder access (Chrome or Edge).

## Web

Unzip `QuillLoom-<v>-web.zip` onto any static web host (GitHub Pages, Netlify, an Apache or nginx folder). Served over HTTPS, the app works offline after the first visit and can be installed as an app from Chrome or Edge. It does not need a server-side component.

To try it locally:

```bash
npx serve QuillLoom-<v>-web
```

In Chrome and Edge, **Open Site** reads and writes a real folder on your computer (the File System Access API). Other browsers open a folder read-only and save sites as ZIP or `.qlsite` files.

## Desktop and web: what differs

| | Desktop app | Web app |
|---|---|---|
| Open a site folder and save back into it | Yes | Chrome and Edge; read-only elsewhere |
| Publish over FTP / FTPS | Yes | No (browsers cannot open FTP connections); publish to a folder or ZIP instead |
| Preview runs the page's scripts | Yes, on a separate preview origin | Yes, in a sandboxed frame |
| Open web files from the file manager | Yes (file associations) | Installed web app in Chrome and Edge |
