/** Detecting whether the data directory will actually survive a redeploy. */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Whether a path sits on a mounted volume rather than the container's own
 * filesystem. Returns null where it cannot tell, which is anywhere without
 * /proc — development machines, mostly.
 *
 * This exists because the failure it catches is silent and expensive. A
 * container without an attached volume still writes happily; the data is simply
 * discarded the next time the container is replaced, and the only symptom is an
 * empty database after a deploy. Worse, `VOLUME` in a Dockerfile creates an
 * anonymous volume, so the data survives a *restart* — which makes it look
 * persistent right up until the first real redeploy destroys it.
 */
export function isOnMountedVolume(path: string): boolean | null {
  let mounts: string[];
  try {
    mounts = readFileSync('/proc/self/mountinfo', 'utf8')
      .split('\n').map((line) => line.split(' ')[4]).filter((p): p is string => !!p);
  } catch {
    return null;
  }
  // Walk up to the nearest mount point. If that is the root filesystem, the
  // path is in the container layer and will not survive.
  let dir = resolve(path);
  for (;;) {
    if (mounts.includes(dir)) return dir !== '/';
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}
