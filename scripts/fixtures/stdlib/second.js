// Opened by app.js with appWindow.open: proves a second window gets the
// std-lib and the app's own store, then closes itself.
import { appWindow, store } from "./kestrel-native.js";

await store.set("fromSecond", location.pathname);
await appWindow.close();
