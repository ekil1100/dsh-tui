import { spawnSync } from 'node:child_process';
import { copyFileSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const libraries = { darwin: 'libdsh_tui_native.dylib', linux: 'libdsh_tui_native.so', win32: 'dsh_tui_native.dll' };
const library = libraries[process.platform];
if (!library) throw new Error(`Unsupported platform: ${process.platform}`);
const result = spawnSync('cargo', ['build', '--release', '--locked', '--manifest-path', 'native/Cargo.toml', '--target-dir', 'native/target'], { cwd: root, stdio: 'inherit' });
if (result.error) throw new Error('Rust is required to build the MVP native terminal. Install Rust and retry.', { cause: result.error });
if (result.status !== 0) process.exit(result.status ?? 1);
// Never overwrite a mapped library in place; publish a new inode atomically.
const target = `${root}/native/terminal.node`;
const temporary = `${target}.${process.pid}.tmp`;
try {
  copyFileSync(`${root}/native/target/release/${library}`, temporary);
  renameSync(temporary, target);
} finally {
  rmSync(temporary, { force: true });
}
