export type MediaType = { kind: 'image' | 'video'; mimeType: string };
export function mediaType(file: unknown): MediaType | null;
