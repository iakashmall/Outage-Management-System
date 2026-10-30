// In-memory files: globalThis.__files maps uri -> { text, size? }.
const files = (globalThis.__files ??= new Map());
export const Paths = { document: { uri: "file:///doc" } };
export class Directory {
  constructor(parent, name) { this.uri = `${parent.uri}/${name}`; }
  create() {}
}
export class File {
  constructor(parentOrUri, name) { this.uri = name ? `${parentOrUri.uri}/${name}` : parentOrUri; }
  get exists() { return files.has(this.uri); }
  get size() { const f = files.get(this.uri); return f ? (f.size ?? f.text.length) : null; }
  write(text) { files.set(this.uri, { text }); }
  async text() { return files.get(this.uri).text; }
  delete() { files.delete(this.uri); }
}
