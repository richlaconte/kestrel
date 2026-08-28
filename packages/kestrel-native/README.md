# kestrel-native

The typed client runtime for [Kestrel](https://github.com/richlaconte/kestrel) apps —
the `kestrel/native` API surface (app, store, and the `callNative` escape hatch in the
current pre-alpha; the full std-lib is specified in
[RFC-0001](https://github.com/richlaconte/kestrel/blob/main/docs/rfc-0001-native-api.md)).

Most apps don't import this directly for native functions — `kestrel typegen` generates
fully typed stubs from your `native.ts`. MIT.
