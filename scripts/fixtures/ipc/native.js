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
native.neverSettles = () => new Promise(() => {});
native.spin = ({ ms }) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
  return "spun";
};
native.report = (results) => {
  hostWriteFile("ipc-results.json", JSON.stringify(results, null, 2));
  return true;
};
