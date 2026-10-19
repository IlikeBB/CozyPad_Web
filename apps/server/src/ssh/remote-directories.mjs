import { remoteDirectoryPath, virtualDirectoryPath } from '../../../../packages/contracts/src/directory-context.mjs';

const invoke = (sftp, method, ...args) => new Promise((resolve, reject) => sftp[method](...args, (error, value) => error ? reject(error) : resolve(value)));
export class RemoteDirectories {
  constructor(files, history, profiles) { Object.assign(this, { files, history, profiles }); }
  async list(owner, id) { await this.profiles.find(owner, id); return this.history.list(owner, id); }
  async select(owner, id, requested) {
    const profile = await this.profiles.find(owner, id);
    requested = remoteDirectoryPath(virtualDirectoryPath(requested, profile.platform));
    const sftp = await this.files.ssh.sftp(owner, id);
    try {
      const target = await invoke(sftp, 'realpath', await this.files.location(sftp, requested));
      if (!(await invoke(sftp, 'stat', target)).isDirectory()) throw Object.assign(new Error('此路徑不是資料夾。'), { status: 400 });
      return { path: target, history: await this.history.remember(owner, id, target) };
    } catch (error) {
      if (error.code === 2) throw Object.assign(new Error('遠端工作目錄不存在。'), { status: 404 });
      if (error.code === 3) throw Object.assign(new Error('SSH 帳號無權讀取此目錄。'), { status: 403 });
      throw error;
    } finally { sftp.end(); }
  }
}
