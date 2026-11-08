import protobuf from 'protobufjs';
import descriptor from '../proto/descriptor.json' with { type: 'json' };

/** Version of the vendored ProPresenter 7 proto definitions (recorded in every import log). */
export const PRO7_PROTO_VERSION: string = (descriptor as { version: string }).version;

let root: protobuf.Root | null = null;

/** The protobufjs root built from the generated JSON descriptor (no file-system access needed). */
export function pro7Root(): protobuf.Root {
  if (!root) root = protobuf.Root.fromJSON((descriptor as { root: protobuf.INamespace }).root);
  return root;
}

export function pro7Type(name: 'rv.data.Presentation' | 'rv.data.PlaylistDocument' | string): protobuf.Type {
  return pro7Root().lookupType(name);
}

// biome-ignore lint/suspicious/noExplicitAny: decoded protobuf messages are dynamically shaped
export type Msg = Record<string, any>;

/** Decode bytes as `type`, returning a plain object (camelCase fields, enum names, numbers for longs). */
export function decodeAs(typeName: string, bytes: Uint8Array): Msg {
  const t = pro7Type(typeName);
  const m = t.decode(bytes);
  return t.toObject(m, { enums: String, longs: Number, defaults: false, oneofs: true }) as Msg;
}
