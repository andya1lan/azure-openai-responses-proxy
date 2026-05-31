export function connect() {
  return {
    opened: Promise.resolve({}),
    closed: Promise.resolve({}),
    close: () => {},
    writer: { write: () => {} },
    reader: { read: () => {} },
  };
}
