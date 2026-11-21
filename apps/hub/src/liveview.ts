/**
 * The live service as the library side sees it: edit locks and the mode (from IPC in the library process). A file of
 * its own so that the modules the library imports (the picture store) need not import the routes, which pull the
 * whole web framework into every program that reads them.
 */
export type LiveView = {
  locks(): { playlistId?: string; presentations: Set<string>; media: Set<string>; fonts: Set<string> };
  mode(): 'idle' | 'live';
  /** Whether the service's state has been told yet: false in a library process until the supervisor's first word. */
  known(): boolean;
};
