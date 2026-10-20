const formats = {
  png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'],
  gif: ['image', 'image/gif'], webp: ['image', 'image/webp'], avif: ['image', 'image/avif'],
  bmp: ['image', 'image/bmp'], ico: ['image', 'image/x-icon'], svg: ['image', 'image/svg+xml'],
  mp4: ['video', 'video/mp4'], m4v: ['video', 'video/mp4'], webm: ['video', 'video/webm'],
  ogv: ['video', 'video/ogg'], mov: ['video', 'video/quicktime']
};

export function mediaType(file) {
  if (typeof file !== 'string') return null;
  const extension = /\.([a-z0-9]+)$/i.exec(file.split(/[\\/]/).at(-1))?.[1].toLowerCase();
  const format = Object.hasOwn(formats, extension) ? formats[extension] : null;
  return format ? { kind: format[0], mimeType: format[1] } : null;
}
