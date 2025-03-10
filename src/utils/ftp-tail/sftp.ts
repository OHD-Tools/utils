import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import fs, { PathLike } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import Client from 'ssh2-sftp-client';
export type SFTPTailOptions = {
  sftp: {
    timeout: number;
    encoding: string;
    host: string;
    port: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    debug: any;
  };
  fetchInterval: number;
  tailLastBytes: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log: ((...data: any) => unknown) | boolean;
};
export class SFTPTail extends EventEmitter<{
  connected: [void];
  disconnect: [void];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: [any];
  line: [string];
}> {
  protected client: Client;
  options: SFTPTailOptions;
  filePath: string | null;
  fetchLoopActive: boolean;
  lastByteReceived: number | null;
  fetchLoopPromise: null | Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log: (...data: any) => unknown;
  tmpFilePath!: PathLike;
  constructor(options: Partial<SFTPTailOptions>) {
    super();

    // Set default options.
    this.options = {
      sftp: {} as SFTPTailOptions['sftp'],
      fetchInterval: 0,
      tailLastBytes: 10 * 1000,
      log: false,
      ...options,
    };

    // Setup basic-ftp client.
    this.client = new Client();

    // Setup logger.
    if (typeof this.options.log === 'function') {
      this.log = this.options.log;
      this.options.sftp.debug = this.options.log;
    } else if (this.options.log) {
      this.log = console.log;
      this.options.sftp.debug = console.log;
    } else {
      this.log = () => {};
      this.options.sftp.debug = () => {};
    }

    // Setup internal properties.
    this.filePath = null;
    this.lastByteReceived = null;

    this.fetchLoopActive = false;
    this.fetchLoopPromise = null;
  }

  async watch(filePath: string) {
    this.filePath = filePath;

    // Setup temp file.
    this.tmpFilePath = path.join(
      process.cwd(),
      crypto
        .createHash('md5')
        .update(
          `${this.options.sftp.host}:${this.options.sftp.port}:${this.filePath}`,
        )
        .digest('hex') + '.tmp',
    );

    // Connect.
    await this.connect();

    // Start fetch loop.
    this.log('Starting fetch loop...');
    this.fetchLoopActive = true;
    this.fetchLoopPromise = this.fetchLoop();
  }

  async unwatch() {
    this.log('Stopping fetch loop...');
    this.fetchLoopActive = false;
    await this.fetchLoopPromise;
  }

  async fetchLoop() {
    while (this.fetchLoopActive) {
      try {
        // Store the start time of the loop.
        const fetchStartTime = Date.now();

        // Reconnect the FTP client in case it has disconnected.
        await this.connect();

        // Get the size of the file on the FTP server.
        this.log('Fetching size of file...');
        const fileSize = (await this.client.stat(this.filePath as string)).size;
        this.log(`File size is ${fileSize}.`);

        // If the file size has not changed then skip this loop iteration.
        if (fileSize === this.lastByteReceived) {
          this.log('File has not changed.');
          await this.sleep(this.options.fetchInterval);
        }

        // If the file has not been tailed before or it has been decreased in size download the last
        // few bytes.
        if (
          this.lastByteReceived === null ||
          this.lastByteReceived > fileSize
        ) {
          this.log('File has not been tailed before or has decreased in size.');
          this.lastByteReceived = Math.max(
            0,
            fileSize - this.options.tailLastBytes,
          );
        }

        // Download the data to a temp file overwritting any previous data.
        this.log(`Downloading file with offset of ${this.lastByteReceived}...`);
        await this.client.get(
          this.filePath as string,
          this.tmpFilePath as string,
          {
            readStreamOptions: {
              start: this.lastByteReceived,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          },
        );

        // Update the last byte marker - this is so we can get data since this position on the next
        // FTP download.
        const downloadSize = fs.statSync(this.tmpFilePath).size;
        this.lastByteReceived += downloadSize;
        this.log(`Downloaded file of size ${downloadSize}.`);

        // Get contents of download.
        const data = await readFile(this.tmpFilePath, 'utf8');

        // Only continue if something was fetched.
        if (data.length === 0) {
          this.log('No data was fetched.');
          await this.sleep(this.options.fetchInterval);
          continue;
        }

        data
          // Remove trailing new lines.
          .replace(/\r\n$/, '')
          // Split the data on the lines.
          .split('\r\n')
          // Emit each line.
          .forEach((line) => this.emit('line', line));

        // Log the loop runtime.
        const fetchEndTime = Date.now();
        const fetchTime = fetchEndTime - fetchStartTime;
        this.log(`Fetch loop took ${fetchTime}ms.`);

        await this.sleep(this.options.fetchInterval);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        this.emit('error', err);
        this.log(`Error in fetch loop: ${err.stack}`);
      }
    }

    if (fs.existsSync(this.tmpFilePath)) {
      fs.unlinkSync(this.tmpFilePath);
      this.log('Deleted temp file.');
    }

    await this.disconnect();
  }

  async connect() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((this.client as any).sftp) return;

    this.log('Connecting to SFTP server...');
    await this.client.connect(this.options.sftp);
    this.emit('connected');
    this.log('Connected to SFTP server.');
  }

  async disconnect() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(this.client as any).sftp) return;

    this.log('Disconnecting from SFTP server...');
    await this.client.end();
    this.emit('disconnect');
    this.log('Disconnected from SFTP server.');
  }

  async sleep(ms: number) {
    this.log(`Sleeping for ${ms} seconds...`);
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
