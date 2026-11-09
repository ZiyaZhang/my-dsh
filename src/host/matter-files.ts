/**
 * The Host's part of a matter's sources: a typed or picked path must exist and is used where it is; a file uploaded through DSH is copied
 * into `<data directory>/matters/<matter id>/files/`; a link is read again here rather than trusted from the page.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { RequestError, absolutePath, type MatterSource, type UploadSource } from './remote.js';
import { classifyUrl, pathSource } from './sources.js';

/** Read the bytes of an uploaded file from DSH's attachment store. */
export type ReadUpload = (upload: UploadSource, signal?: AbortSignal) => AsyncIterable<Uint8Array>;

/** An existing folder or file at a full path; `~` is the home folder. */
export async function checkPath(raw: string): Promise<MatterSource> {
  const typed = absolutePath(raw);
  const path = typed === '~' || typed.startsWith('~/') ? join(homedir(), typed.slice(1)) : resolve(typed);
  let kind: 'folder' | 'file';
  try {
    kind = (await stat(path)).isDirectory() ? 'folder' : 'file';
  } catch {
    throw new RequestError(`路径不存在：${typed}`);
  }
  return pathSource(path, kind);
}

/** A leaf name that stays inside the folder it is written to. */
function leafName(name: string): string {
  const leaf = basename(name.replace(/\\/g, '/')).replace(/[\p{Cc}]/gu, '').trim();
  return leaf === '' || leaf === '.' || leaf === '..' ? 'file' : leaf;
}

/** `name`, or `name 2`, `name 3`… before the extension, whichever does not exist yet in `folder`. */
async function freeName(folder: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? name : `${stem} ${n}${extension}`;
    try {
      await stat(join(folder, candidate));
    } catch {
      return candidate;
    }
  }
}

/** Copy one uploaded file into `folder`, never over an existing file. */
export async function copyUpload(read: ReadUpload, upload: UploadSource, folder: string, signal?: AbortSignal): Promise<MatterSource> {
  await mkdir(folder, { recursive: true });
  const name = await freeName(folder, leafName(upload.name));
  const path = join(folder, name);
  await pipeline(Readable.from(read(upload, signal)), createWriteStream(path, { flags: 'wx' }), ...(signal ? [{ signal }] : []));
  return { kind: 'file', value: path, title: name };
}

/**
 * Turn the sources a dialog sent into stored ones, in order and once each.
 * @param deps.read - the attachment reader, or undefined when this DSH has no attachment store.
 * @param deps.files - where uploads of this matter are copied.
 */
export async function resolveSources(
  inputs: readonly (MatterSource | UploadSource)[], deps: { read: ReadUpload | undefined; files: string; signal?: AbortSignal },
): Promise<MatterSource[]> {
  const resolved: MatterSource[] = [];
  for (const input of inputs) {
    let source: MatterSource;
    if (input.kind === 'upload') {
      if (!deps.read) throw new RequestError('这里收不了上传的文件');
      source = await copyUpload(deps.read, input, deps.files, deps.signal);
    } else if (input.kind === 'folder' || input.kind === 'file') {
      source = await checkPath(input.value);
    } else {
      source = classifyUrl(input.value);
    }
    if (!resolved.some(kept => kept.value === source.value)) resolved.push(source);
  }
  return resolved;
}
