import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import packageJson from "../../package.json";

export const QUE_REPO_URL = "https://github.com/ZIXT233/Que";
const LATEST_RELEASE_URL = "https://api.github.com/repos/ZIXT233/Que/releases/latest";

export interface AppReleaseResult {
  version: string;
  tag: string;
  newer: boolean;
}

export interface AppUpdateState {
  version: string;
  checking: boolean;
  result: AppReleaseResult | null;
  checkFailed: boolean;
  checkUpdates: () => Promise<void>;
}

export function releaseUrl(tag: string): string {
  return `${QUE_REPO_URL}/releases/tag/${encodeURIComponent(tag)}`;
}

function versionParts(version: string): [number, number, number, boolean] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), !!match[4]];
}

function isNewerRelease(latest: string, installed: string): boolean {
  const a = versionParts(latest);
  const b = versionParts(installed);
  if (!a || !b) throw new Error("Invalid release version");
  for (const index of [0, 1, 2] as const) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return b[3] && !a[3];
}

export function useAppUpdate(autoCheck: boolean): AppUpdateState {
  const [version, setVersion] = useState(packageJson.version);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<AppReleaseResult | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const inFlight = useRef(false);

  const checkUpdates = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    setCheckFailed(false);
    setResult(null);
    try {
      const installed = await getVersion().catch(() => packageJson.version);
      setVersion(installed);
      if (import.meta.env.DEV) {
        setResult({ version: "999dev", tag: "v999dev", newer: true });
        return;
      }
      const response = await fetch(LATEST_RELEASE_URL, {
        headers: { Accept: "application/vnd.github+json" },
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
      const release = await response.json() as { tag_name?: unknown };
      if (typeof release.tag_name !== "string") throw new Error("Missing release tag");
      setResult({
        version: release.tag_name.replace(/^v/, ""),
        tag: release.tag_name,
        newer: isNewerRelease(release.tag_name, installed),
      });
    } catch {
      setCheckFailed(true);
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (autoCheck) void checkUpdates();
  }, [autoCheck, checkUpdates]);

  return { version, checking, result, checkFailed, checkUpdates };
}
