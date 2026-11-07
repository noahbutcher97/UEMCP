import { resolveTestBash } from './shell-test-support.mjs';
import { TestRunner } from './test-helpers.mjs';
const t = new TestRunner('Hook shell selection');
const select = (git, available, env = {}) => resolveTestBash({ platform: 'win32', env,
  run: () => ({ stdout: git }), exists: path => available.includes(path) });
t.assert(select('C:\\Program Files\\Git\\cmd\\git.exe\r\n', ['C:\\Windows\\System32\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'])
  === 'C:\\Program Files\\Git\\bin\\bash.exe', 'Git Bash wins over the WSL launcher');
t.assert(select('E:\\PortableGit\\mingw64\\bin\\git.exe\r\n', ['E:\\PortableGit\\bin\\bash.exe'])
  === 'E:\\PortableGit\\bin\\bash.exe', 'portable Git installation is discovered from git.exe');
t.assert(select('', ['C:\\Apps\\Git\\bin\\bash.exe'], { ProgramFiles: 'C:\\Apps' })
  === 'C:\\Apps\\Git\\bin\\bash.exe', 'standard install fallback works when where is unavailable');
t.assert(select('', ['C:\\Windows\\System32\\bash.exe']) === null, 'missing Git Bash is not replaced by WSL');
t.assert(resolveTestBash({ platform: 'linux', run: () => { throw new Error('unexpected discovery'); } }) === 'bash', 'POSIX uses its native Bash');
process.exit(t.summary());
