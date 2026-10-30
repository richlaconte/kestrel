// e2e fixture: every shape a native function can return. The page calls each
// and hands the outcomes back to `report`, which writes them to disk.
native.sync = ({ n }) => n * 2;
native.asyncValue = async ({ n }) => {
  await null;
  return { doubled: n * 2 };
};
native.asyncChain = async () => {
  const a = await Promise.resolve(1);
  const b = await new Promise((r) => r(2));
  return a + b;
};
native.asyncUndefined = async () => {};
native.rejects = async () => {
  throw new Error("nope");
};
native.throws = () => {
  throw new Error("sync nope");
};
// #19: an uncaught binding error keeps its code; native code can pick one.
native.readMissing = () => hostReadFile("does-not-exist.txt");
native.escape = () => hostReadFile("../outside.txt");
native.cancels = () => {
  const e = new Error("user cancelled");
  e.code = "cancelled";
  throw e;
};
native.neverSettles = () => new Promise(() => {});
native.spin = ({ ms }) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
  return "spun";
};
// #22: events pushed to the webview while a call runs.
native.progress = ({ n }) => {
  for (let i = 1; i <= n; i++) hostEmit("progress", JSON.stringify({ i }));
  hostEmit("other", "null");
  return n;
};
native.report = (results) => {
  hostWriteFile("ipc-results.json", JSON.stringify(results, null, 2));
  return true;
};
