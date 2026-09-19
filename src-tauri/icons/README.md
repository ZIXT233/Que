# Que icon assets

There are two design sources and one generated output set. Do not edit a PNG or
ICO to change the artwork.

| Path | Purpose |
| --- | --- |
| `source-desktop.svg` | Master artwork for macOS, Linux, iOS, and Android. It carries the white tile and baked-in depth that macOS renders well. |
| `source-windows.svg` | Windows-only master. Its outer tile is larger, while the mark has a larger inset within that tile so 16–32 px taskbar frames stay legible without losing the macOS-like breathing room. |
| `windows/icon.ico` | Generated Windows multi-resolution icon. This is the only ICO Windows bundles; `tauri.windows.conf.json` selects it. |
| `icon.icns`, `32x32.png`, `128x128.png`, `128x128@2x.png` | Generated desktop assets selected by `tauri.conf.json` for macOS/Linux. |
| `ios/` and `android/` | Generated mobile-platform asset matrices. They are required by their platform packagers even though they are not individually listed in the desktop bundle config. |
| `64x64.png`, `icon.png`, and `StoreLogo.png` / `Square*Logo.png` | Generated compatibility and Windows Store assets. Keep them synchronized with the desktop source when the design changes. |

## Updating artwork

1. Change the appropriate `source-*.svg`.
2. Generate the common asset matrix from `source-desktop.svg` with `npx tauri icon`.
3. Generate a temporary matrix from `source-windows.svg` and copy only its
   `icon.ico` to `windows/icon.ico`.
4. Do not point the base Tauri configuration at a root `icon.ico`: Windows has
   its own explicit override.

The old `que-mark-fullbleed.svg` was an identical copy of the desktop source,
and the root `icon.ico` was bypassed by the Windows override, so neither is kept.
