import * as fs from 'fs';

let isDocker: boolean | undefined;

function hasDockerEnv(): boolean {
  try {
    fs.statSync('/.dockerenv');
    return true;
  } catch (_) {
    return false;
  }
}

function hasDockerCGroup(): boolean {
  try {
    return fs.readFileSync('/proc/self/cgroup', 'utf8').includes('docker');
  } catch (_) {
    return false;
  }
}

export function isInDocker(): boolean {
  if (isDocker === undefined) {
    isDocker = hasDockerEnv() || hasDockerCGroup();
  }

  return isDocker;
}
