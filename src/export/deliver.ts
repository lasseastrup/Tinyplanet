import { isMobileDevice } from '../render/quality';

/** File-name friendly version of a planet name. */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export type DeliveryResult = 'shared' | 'downloaded' | 'cancelled' | 'needs-tap';

/**
 * Hand a generated file to the user: the native share sheet on phones (lets iOS users save to
 * Files/Photos from a home-screen app), a regular download elsewhere.
 *
 * The share sheet needs a recent user gesture; after slow work (e.g. a big export) it may be
 * refused. Then `askForTap` is called with a retry function to run from a fresh tap.
 */
export async function deliverFile(
  blob: Blob,
  filename: string,
  title: string,
  askForTap?: (retry: () => void) => void,
): Promise<DeliveryResult> {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (isMobileDevice() && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === 'AbortError') return 'cancelled';
      if (name === 'NotAllowedError' && askForTap) {
        askForTap(() => {
          navigator.share({ files: [file], title }).catch(() => downloadBlob(blob, filename));
        });
        return 'needs-tap';
      }
      // Fall through to a download.
    }
  }
  downloadBlob(blob, filename);
  return 'downloaded';
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}
