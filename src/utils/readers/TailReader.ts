/* eslint-disable @typescript-eslint/no-explicit-any */
import path from 'node:path';

type TailLogReaderOptions = { logDir: string; filename: string };
export default class TailLogReader {
  /**@type {import('tail').Tail} */
  protected reader: unknown;
  options: TailLogReaderOptions;
  queueLine!: (data: any) => unknown;
  constructor(
    queueLine: (data: any) => unknown,
    options = {} as TailLogReaderOptions,
  ) {
    if (!('logDir' in options)) throw new Error(`logDir must be specified.`);

    if (typeof queueLine !== 'function')
      throw new Error(
        'queueLine argument must be specified and be a function.',
      );
    this.options = options;
    this.queueLine = queueLine;
  }

  async setup() {
    const TailModule = await import('tail');
    this.reader = new TailModule.Tail(
      path.join(this.options.logDir, this.options.filename),
      {
        useWatchFile: true,
      },
    );
    (this.reader as any).on('line', this.queueLine);
  }

  async watch() {
    (this.reader as any).watch();
  }

  async unwatch() {
    (this.reader as any).unwatch();
  }
}
