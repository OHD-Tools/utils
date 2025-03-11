/* eslint-disable @typescript-eslint/no-explicit-any */
import path from 'path';
import { SFTPTail, type SFTPTailOptions } from '../ftp-tail';

type TailLogReaderOptions = {
  fetchInterval: number;
  maxTempFileSize: number;
  logDir: string;
  filename: string;
  sftp: SFTPTailOptions['sftp'];
};
export default class TailLogReader {
  options: Partial<TailLogReaderOptions>;
  reader!: SFTPTail;
  queueLine!: (data: any) => unknown;
  constructor(
    queueLine: (data: any) => unknown,
    options = {} as TailLogReaderOptions,
  ) {
    for (const option of ['sftp', 'logDir'])
      if (!(option in options)) throw new Error(`${option} must be specified.`);

    this.options = options;

    if (typeof queueLine !== 'function')
      throw new Error(
        'queueLine argument must be specified and be a function.',
      );
  }

  async setup() {
    this.reader = new SFTPTail({
      sftp: this.options.sftp,
      fetchInterval: this.options.fetchInterval ?? 0,
      maxTempFileSize: this.options.maxTempFileSize ?? 5 * 1000 * 1000, // 5 MB
    } as any);
    this.reader.on('line', this.queueLine);
  }

  async watch() {
    await this.reader.watch(
      path
        .join(this.options.logDir as string, this.options.filename as string)
        .replace(/\\/g, '/'),
    );
  }

  async unwatch() {
    await this.reader.unwatch();
  }
}
