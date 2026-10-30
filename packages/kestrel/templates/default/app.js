// Typed stubs generated from native.js by `kestrel typegen`:
import { greet, visitCount } from "./native-client.js";

visitCount().then(n => {
  document.getElementById("visits").textContent =
    `you have opened this app ${n} time${n === 1 ? "" : "s"} (persisted by native.js)`;
});

document.getElementById("greet").onclick = async () => {
  const name = document.getElementById("name").value || "stranger";
  document.getElementById("msg").textContent = await greet({ name });
};
