/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import fs, { PathLike } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type FTPTailOptions = {
  ftp: {
    timeout: number;
    encoding:
      | 'base64'
      | 'hex'
      | 'binary'
      | 'utf8'
      | 'ascii'
      | 'utf-8'
      | 'utf16le'
      | 'ucs2'
      | 'ucs-2'
      | 'latin1'
      | undefined;
    host: string;
    port: number;
  };
  fetchInterval: number;
  tailLastBytes: number;

  log: ((...data: any) => unknown) | boolean;
};
export class FTPTail extends EventEmitter<{
  connected: [void];
  disconnect: [void];
  error: [any];
  line: [string];
}> {
  protected client: any;
  options: FTPTailOptions;
  filePath: string | null;
  fetchLoopActive: boolean;
  lastByteReceived: number | null;
  fetchLoopPromise: null | Promise<void>;

  log: (...data: any) => unknown;
  tmpFilePath!: PathLike;
  constructor(options: Partial<FTPTailOptions>) {
    super();

    // Set default options.
    this.options = {
      ftp: {} as FTPTailOptions['ftp'],
      fetchInterval: 0,
      tailLastBytes: 10 * 1000,
      log: false,
      ...options,
    };

    // Setup logger.
    if (typeof this.options.log === 'function') {
      this.log = this.options.log;
      this.client.ftp.log = this.options.log;
    } else if (this.options.log) {
      this.log = console.log;
      this.client.ftp.log = console.log;
    } else {
      this.log = () => {};
      this.client.ftp.log = () => {};
    }

    // Setup internal properties.
    this.filePath = null;
    this.lastByteReceived = null;

    this.fetchLoopActive = false;
    this.fetchLoopPromise = null;
  }

  async setup() {
    const { Client } = await import('basic-ftp');
    // Setup basic-ftp client.
    this.client = new Client(this.options.ftp.timeout);
    this.client.ftp.encoding =
      this.options.ftp.encoding ?? this.client.ftp.encoding;
  }

  async watch(filePath: string) {
    this.filePath = filePath;

    // Setup temp file.
    this.tmpFilePath = path.join(
      process.cwd(),
      crypto
        .createHash('md5')
        .update(
          `${this.options.ftp.host}:${this.options.ftp.port}:${this.filePath}`,
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
        const fileSize = await this.client.size(this.filePath as string);
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
        await this.client.downloadTo(
          fs.createWriteStream(this.tmpFilePath, { flags: 'w' }),
          this.filePath as string,
          this.lastByteReceived,
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
    if (!this.client.closed) return;

    this.log('Connecting to FTP server...');
    await this.client.access(this.options.ftp);
    this.emit('connected');
    this.log('Connected to FTP server.');
  }

  async disconnect() {
    if (this.client.closed) return;

    this.log('Disconnecting from FTP server...');
    await this.client.close();
    this.emit('disconnect');
    this.log('Disconnected from FTP server.');
  }

  async sleep(ms: number) {
    this.log(`Sleeping for ${ms} seconds...`);
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
