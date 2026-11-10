import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const SAFE_NAME = /^[a-f0-9]{48}\.(?:png|jpg|webp)$/;
export function imageType(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}
export class FileImageStore {
  constructor(directory, ttlMs, now = Date.now) {
    this.directory = path.resolve(directory); this.ttlMs = ttlMs; this.now = now;
    this.timer = setInterval(() => this.cleanup().catch(() => {}), Math.min(ttlMs, 60000));
    this.timer.unref();
  }
  async save(bytes, mime) {
    const extension = MIME_EXT[mime];
    if (!extension || imageType(bytes)?.mime !== mime) throw new Error('Unsupported generated image');
    const filename = `${randomBytes(24).toString('hex')}.${extension}`;
    await fs.mkdir(this.directory, { recursive: true });
    await fs.writeFile(path.join(this.directory, filename), bytes, { flag: 'wx', mode: 0o600 });
    return filename;
  }
  async read(filename) {
    if (!SAFE_NAME.test(filename)) return null;
    const fullPath = path.join(this.directory, filename);
    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) return null;
      if (this.now() - stat.mtimeMs >= this.ttlMs) { await fs.unlink(fullPath); return null; }
      const mime = Object.entries(MIME_EXT).find(([, extension]) => filename.endsWith(`.${extension}`))?.[0];
      return { bytes: await fs.readFile(fullPath), mime };
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async cleanup() {
    let names;
    try { names = await fs.readdir(this.directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await Promise.all(names.filter(name => SAFE_NAME.test(name)).map(async name => {
      const fullPath = path.join(this.directory, name);
      try { const stat = await fs.stat(fullPath); if (stat.isFile() && this.now() - stat.mtimeMs >= this.ttlMs) await fs.unlink(fullPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }));
  }
  close() { clearInterval(this.timer); }
}
