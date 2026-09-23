# Windows Defender investigation — 2026-09-22

## Observed evidence

- Local Defender Operational events 1116/1117 identify
  `Trojan:Win32/Bearfoos.A!ml` (2147731250). The latest observed quarantine was
  2026-09-22 11:48:17, local time, for `%LOCALAPPDATA%\Que\que.exe`.
- Earlier detections occurred during MSI installation, archive scanning and
  file reads, not only while Que was running. The recorded Intel `esrv_svc.exe`
  process is the process associated with a detection, not evidence that Que
  launched it or that Intel caused the classification.
- The downloaded `Que-windows-x64-msi (4).zip` reproduces the detection with
  `MpCmdRun -Scan -ScanType 3 -DisableRemediation`. Its reported member is
  `Que_0.1.0_x64_en-US.msi -> app.cab -> Path`.
  SHA-256: `5C4A9832387C7039CE3FFD4990C3C89FC5920B495D3D625027AE38C0544EA63D`.
- The older local `src-tauri/target/release/que.exe` (September 21, 01:01)
  returns no threats using the same scanner. It is unsigned, SHA-256:
  `7C48F8CBDF74D0CA00CE702205FA34474DB5320660AF109BBEA0AD1D652C21C5`.
  This is a different artifact, not proof that the downloaded build is safe.
- Engine: `1.1.26080.3`; security intelligence: `1.459.321.0`.
  Full local output: `logs/defender/scan-20260922-123331-800.json` (git-ignored).
- Que's own log ends at 03:48:05 UTC / 11:48:05 local with an SSE listener
  disconnect. It does not reveal Defender's internal reason for classification.

These observations establish a reproducible detection, not its source-level
cause or a confirmed false-positive determination. Event logs do not identify
the matching code or classifier features. This is an antivirus detection,
not merely a SmartScreen reputation warning.

## Changes

- Window activation passes the project name as environment data instead of
  interpolating it into executable PowerShell. Matching is literal and ignores
  case. It uses the system PowerShell path instead of searching PATH.
- Que's ConPTY loader uses an absolute DLL path and limits dependency search to
  that DLL's directory and System32. Automatic working-directory resource lookup
  is development-only; installed builds use bundled/executable-relative paths.
  The explicit `QUE_CONPTY_DIR` developer override remains available.
- `scripts/scan-windows-artifacts.ps1` records SHA-256, Authenticode status,
  engine/signature versions, native scan output and exit status. Detections,
  scan errors, missing files and files changed during scanning fail the command.
  It does not modify Defender settings. Real-time protection remains active.
- Windows release jobs scan EXE/installers and retain JSON reports. The Tauri
  action has already uploaded assets to a **draft** at this point; a failed
  scan fails the workflow but does not remove that draft or prevent someone
  manually publishing it. Review the report before publishing.

The code changes fix independently identifiable safety issues. They are not
claimed to remove `Bearfoos` detections. No compiler/packing changes are made
just to change the binary fingerprint.

## Recheck the exact release

### Commit-window investigation

Read-only source/history review and additional artifact scans narrowed a
present-day scan transition to adjacent commits. Download source URLs were
read from each ZIP's Zone.Identifier (signed download URLs were not retained).
The GitHub Actions pages identify the commit for each run:

| Local ZIP suffix | Actions run | Commit | Scan result |
| --- | --- | --- | --- |
| no suffix | 35525490186 | 4e0c3bb | No threats |
| (1) | 35615518395 | 99b7aba | No threats |
| (2) | 35632873688 | 45cbffa | Bearfoos |
| (4) | 35647605547 | 05226df | Bearfoos (earlier scan) |

The published artifact digests for runs 35632873688 and 35647605547 exactly
match the locally scanned ZIP hashes. Run 35615518395 has been rerun and its
currently visible artifact table lacks the Windows digest, so the (1) mapping
relies on its download source metadata and the run's commit, not a digest match.
New scan report: `logs/defender/scan-20260922-125525-170.json`.

`git diff 99b7aba 45cbffa` changes only `src-tauri/src/harness/windows.rs`, adding
29 lines. When replacement of a hook executable fails with Windows error 5 or
32, the installer renames the old executable to a UUID `.old` filename, retries
renaming the newly written `.tmp` executable into place, and cleans stale files.
Its purpose is legitimate updating of a helper held open by a live MCP session.
This executable-write/replace sequence is the strongest source-level candidate
for the observed adjacent-artifact difference, not a confirmed classifier rule.

The PE embedding/extraction infrastructure predates this interval: 95f49a5
(September 20 04:57) compiled a native hook helper, embedded it with
`include_bytes!`, wrote it to disk and registered it with CLI hooks/MCP. Devin
support in 3b59072 extends that existing mechanism, but the subsequent 99b7aba
download currently scans clean. The old local EXE also contains a second valid
DOS/PE header at offset 9861399, consistent with an embedded executable; the new
local EXE has only its main header. Header inspection alone does not identify
or execute the embedded program. Embedding is therefore not sufficient on its
own to predict these samples' detections.

Important counterevidence:
- 05226df removes native hook embedding/extraction and replacement, yet its
  downloaded ZIP still detects. Its commit message attributes Bearfoos to the
  native helper, but that attribution is not a Microsoft finding or proof.
- Historical Defender events already show detections on September 21 around
  01:18, before 45cbffa (September 22 01:34). The adjacent-artifact transition
  above is today's scan result, not the first-ever onset of the problem.
- 235824a's junction-resolution change occurs after the detected 45cbffa sample,
  so it cannot explain that sample. It resolves reparse targets explicitly;
  it does not alter Defender settings.
- `focus.rs` and `conpty.rs` have no committed changes in 52b979b..05226df.
  The investigation's later hardening of them is not evidence for a regression
  introduced during this commit window.
- The main Cargo dependency manifest/lock and CI workflows have no committed
  changes in that range. CI still uses a floating stable Rust toolchain and
  hosted runner images; actual build-environment equivalence was not established.

No application code was changed or historical binaries rebuilt during this
commit review. Establishing causality would require a controlled reproduction
with recorded toolchains and matched build inputs, or Microsoft's analysis.

Run pages:
- https://github.com/ZIXT233/Que/actions/runs/35525490186
- https://github.com/ZIXT233/Que/actions/runs/35615518395
- https://github.com/ZIXT233/Que/actions/runs/35632873688
- https://github.com/ZIXT233/Que/actions/runs/35647605547

### Correction: the user's successful run was the older local MSI

The user clarified that the installer they ran was
`src-tauri/target/release/bundle/msi/Que_0.1.0_x64_en-US.msi`, **not** the new
`target/defender-review` build. The referenced file's last-write time is
2026-09-21 01:01:39, its size is 6,545,408 bytes, and its SHA-256 is
`D3C0D0AE1FEA40AEE9ECECEF080306E8E306E4903B9BFAFA91206814A87B4549`.
At 12:51 on September 22 it also returned no threats; report:
`logs/defender/scan-20260922-125114-019.json`.

The user's successful runtime observation therefore applies to this older
local installer. It does not validate runtime behavior of the new build or
show that this investigation's code changes resolved detection. The new
build's EXE/MSI scan results below remain valid. The evidence now distinguishes
a detected downloaded artifact from two locally built artifacts that scanned
clean; the reason for that difference remains unknown.

### Validation completed in this investigation

- Frontend production build passed; existing chunk-size/dynamic-import warnings
  remain.
- Rust library compiled and `conpty::tests::sideloads_the_bundled_conpty_dll`
  passed using the restricted loader (1 passed).
- Release EXE and MSI built successfully in
  `src-tauri/target/defender-review/release`. This independent target directory
  avoids the old cache's stale `D:\Cue` permission-file paths.
- At 12:47 local time, **both new files returned no threats**, with engine
  `1.1.26080.3` and security intelligence `1.459.321.0`; real-time protection
  remained enabled. Report: `logs/defender/scan-20260922-124729-366.json`.
  EXE SHA-256: `3A895332207001E0D6F167BD47B6FA1281414248003AD1A58C95B2566DFEEC5D`.
  MSI SHA-256: `833DEC637B27E3AD97808E6F32BB704A6DB45CAF271E938DE0362E5B4DCD3ECB`.
- Both new artifacts remain unsigned. No installer was run and no GUI behavior
  was verified. The GitHub workflow changes were reviewed locally, not executed
  on hosted runners; they require an available, enabled Defender installation.
- This was not a controlled source-level A/B comparison: the downloaded build,
  older local build and current working tree are different. A clean new build
  does not establish which change affected classification or resolve the old
  download's detection. There were pre-existing working-tree changes, preserved
  throughout this investigation.

Run in PowerShell from the repository root after signing and packaging:

```powershell
./scripts/scan-windows-artifacts.ps1 -Artifact @(
  'src-tauri/target/release/que.exe',
  'src-tauri/target/release/bundle/msi/Que_0.1.0_x64_en-US.msi',
  'src-tauri/target/release/bundle/nsis/Que_0.1.0_x64-setup.exe'
)
```

For target-specific builds, insert the target triple before `release`.
Also scan the actual downloaded ZIP. JSON reports go to `logs/defender` even
when a scan fails. `-DisableRemediation` is a custom-scan option; it does not
turn off real-time protection. Its detections appear in command output rather
than Protection History. A clean result applies only to those bytes and that
scanner/signature version; it does not guarantee other devices or future scans.

CI compatibility correction (September 23): GitHub's Windows runner images
disable real-time monitoring. The script records that state but no longer
requires it to be enabled before running an explicit custom scan. Defender
antivirus must still be enabled and every artifact must pass the scan and hash
check. No Defender settings are changed. The custom scan's
`-DisableRemediation` option ignores file exclusions and scans archives, as
documented in the MpCmdRun reference below. The earlier report with
`scanner: null` and `artifacts: []` was a precondition failure, not a completed
malware scan. The final publish job also explicitly sets `GH_REPO`, since it
runs without a repository checkout. These corrections require a fresh tagged
workflow run for hosted-runner validation.

For an incorrectly detected release, submit the exact detected file through
[Microsoft's developer submission portal](https://www.microsoft.com/en-us/wdsi/filesubmission).
The submission should include the threat name, SHA-256 and saved scan output.
No file has been uploaded by this investigation.

Consistent trusted Authenticode signing helps establish publisher identity,
but is not an antivirus exemption. No CurrentUser code-signing certificate was
found locally, and the release workflow has no signing configuration. Signing
requires a real publisher certificate/service; it cannot be completed by adding
a fictional identity or a self-signed certificate.

References:
- [Microsoft developer FAQ](https://learn.microsoft.com/en-us/defender-xdr/developer-faq)
- [MpCmdRun options](https://learn.microsoft.com/en-us/defender-endpoint/command-line-arguments-microsoft-defender-antivirus)
- [Tauri Windows signing](https://tauri.app/distribute/sign/windows/)
- [LoadLibraryExW search flags](https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-loadlibraryexw)
